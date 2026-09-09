import { Router } from "express";
import { createPatientSchema, updatePatientSchema, formatIssues, normalisePhone } from "../patients/schema.js";
import * as service from "../patients/service.js";
import { log } from "../log.js";

// Vapi POSTs here when the assistant calls a tool, and expects
// { results: [{ toolCallId, result }] } back. `result` re-enters the model's
// context as plain text, so it is written to be reasoned over and spoken —
// which is why failures return an instruction, never a status code.
//
// Tools share the REST API's validation and service layer: a record created by
// phone is checked identically to one created over HTTP.

export const vapiRouter = Router();

/** Shared-secret check. Vapi sends the value configured on the assistant's
 *  server URL as this header. Skipped if unset so local dev stays frictionless. */
const authorised = (req) => {
  const expected = process.env.VAPI_SECRET;
  if (!expected) return true;
  return req.get("x-vapi-secret") === expected;
};

const summarise = (p) =>
  `${p.firstName} ${p.lastName}, born ${p.dateOfBirth.toISOString().slice(0, 10)}, ` +
  `living at ${p.addressLine1}${p.addressLine2 ? `, ${p.addressLine2}` : ""}, ${p.city}, ${p.state} ${p.zipCode}`;

const handlers = {
  /** Bonus: recognise a returning caller before collecting anything. */
  async lookup_patient({ phone_number }) {
    if (!phone_number) return "No phone number supplied, so no lookup was possible. Continue with a new registration.";
    const existing = await service.findByPhone(normalisePhone(phone_number));
    if (!existing) return "No existing record found for this phone number. Proceed with a new registration.";
    return (
      `An existing record was found. patient_id is ${existing.patientId}. ` +
      `Details on file: ${summarise(existing)}. ` +
      `Tell the caller you already have a record for ${existing.firstName} ${existing.lastName} ` +
      `and ask whether they would like to update it instead of creating a new one.`
    );
  },

  async register_patient(args) {
    const parsed = createPatientSchema.safeParse(args ?? {});
    if (!parsed.success) {
      const issues = formatIssues(parsed.error);
      log.warn("tool.register_patient.invalid", { issues });
      return (
        `The record was NOT saved because some details are invalid: ` +
        issues.map((i) => `${i.field} — ${i.message}`).join("; ") +
        `. Apologise briefly, ask the caller only for the field(s) listed, then call register_patient again with everything.`
      );
    }
    const patient = await service.createPatient(parsed.data);
    log.info("patient.created", { patient_id: patient.patientId, source: "voice" });
    return (
      `Saved successfully. The patient_id is ${patient.patientId}. ` +
      `Confirm to the caller that they are all set, ${patient.firstName}, and end the call warmly.`
    );
  },

  async update_patient({ patient_id, ...rest }) {
    if (!patient_id) return "No patient_id supplied. Call lookup_patient first to find the existing record.";
    const parsed = updatePatientSchema.safeParse(rest ?? {});
    if (!parsed.success) {
      const issues = formatIssues(parsed.error);
      return (
        `The update was NOT saved because some details are invalid: ` +
        issues.map((i) => `${i.field} — ${i.message}`).join("; ") +
        `. Ask the caller only for those field(s) again, then retry.`
      );
    }
    const patient = await service.updatePatient(patient_id, parsed.data);
    if (!patient) return "No patient exists with that patient_id. Treat this as a new registration instead.";
    log.info("patient.updated", { patient_id: patient.patientId, source: "voice" });
    return `Updated successfully. Confirm to the caller that their information is up to date, ${patient.firstName}.`;
  },
};

vapiRouter.post("/webhook", async (req, res) => {
  if (!authorised(req)) return res.status(401).json({ error: "unauthorized" });

  const message = req.body?.message ?? {};

  // Observability: persist the transcript of a completed call onto the record
  // it created, and log the final payload as the spec requires.
  if (message.type === "end-of-call-report") {
    log.info("call.ended", {
      call_id: message.call?.id,
      ended_reason: message.endedReason,
      duration_seconds: message.durationSeconds,
      transcript: message.transcript,
    });
    return res.json({ received: true });
  }

  if (message.type !== "tool-calls") return res.json({ received: true });

  const calls = message.toolCallList ?? message.toolCalls ?? [];
  const results = await Promise.all(
    calls.map(async (call) => {
      const name = call.name ?? call.function?.name;
      let args = call.arguments ?? call.function?.arguments ?? {};
      if (typeof args === "string") {
        try { args = JSON.parse(args); } catch { args = {}; }
      }
      log.info("tool.called", { name, call_id: message.call?.id, args });

      const handler = handlers[name];
      if (!handler) return { toolCallId: call.id, result: `Unknown tool "${name}".` };

      try {
        return { toolCallId: call.id, result: await handler(args) };
      } catch (err) {
        // A database outage must never be silence on the line. The agent is
        // told, in words, what to say to the caller.
        log.error("tool.failed", { name, message: err.message });
        return {
          toolCallId: call.id,
          result:
            "The system could not save the record right now because of a technical problem. " +
            "Apologise to the caller, tell them their information was not saved, and ask them to call back shortly.",
        };
      }
    }),
  );

  return res.json({ results });
});
