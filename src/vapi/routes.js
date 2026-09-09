import { Router } from "express";
import { createPatientSchema, updatePatientSchema, formatIssues, normalisePhone } from "../patients/schema.js";
import * as service from "../patients/service.js";
import { log } from "../log.js";

export const vapiRouter = Router();

const authorised = (req) => {
  const expected = process.env.VAPI_SECRET;
  if (!expected) return true;
  return req.get("x-vapi-secret") === expected;
};

const describe = (p) =>
  `${p.firstName} ${p.lastName}, born ${p.dateOfBirth.toISOString().slice(0, 10)}, ` +
  `phone ${p.phoneNumber}, ${p.addressLine1}${p.addressLine2 ? `, ${p.addressLine2}` : ""}, ` +
  `${p.city}, ${p.state} ${p.zipCode}`;

const rejection = (issues, retryWith) =>
  `NOT SAVED. These fields are invalid: ${issues.map((i) => `${i.field} (${i.message})`).join("; ")}. ` +
  `Ask the caller only about those fields, then call ${retryWith} again with the complete set.`;

const handlers = {
  async lookup_patient({ phone_number }) {
    if (!phone_number) return "No phone number available. Continue as a new registration.";

    const existing = await service.findByPhone(normalisePhone(phone_number));
    if (!existing) return "No existing record. Continue as a new registration.";

    return (
      `EXISTING RECORD FOUND. patient_id: ${existing.patientId}. On file: ${describe(existing)}. ` +
      `Greet them by name, say you already have their record, and ask whether they want to update it ` +
      `or register as a new patient.`
    );
  },

  async register_patient(args, { callId }) {
    const parsed = createPatientSchema.safeParse(args ?? {});
    if (!parsed.success) {
      const issues = formatIssues(parsed.error);
      log.warn("registration.rejected", { call_id: callId, issues });
      return rejection(issues, "register_patient");
    }

    const patient = await service.createPatient({ ...parsed.data, vapi_call_id: callId });
    log.info("registration.saved", { call_id: callId, patient: service.toApi(patient) });

    return (
      `SAVED. patient_id: ${patient.patientId}. Tell ${patient.firstName} they are all set ` +
      `and that their registration is complete, then end the call.`
    );
  },

  async update_patient({ patient_id, ...fields }, { callId }) {
    if (!patient_id) return "No patient_id. Call lookup_patient first.";

    const parsed = updatePatientSchema.safeParse(fields ?? {});
    if (!parsed.success) return rejection(formatIssues(parsed.error), "update_patient");

    const patient = await service.updatePatient(patient_id, parsed.data);
    if (!patient) return "No patient with that patient_id. Register them as a new patient instead.";

    log.info("registration.updated", { call_id: callId, patient: service.toApi(patient) });
    return `UPDATED. Tell ${patient.firstName} their information is up to date, then end the call.`;
  },
};

const UNAVAILABLE =
  "The system is temporarily unavailable and nothing was saved. Apologise, tell the caller " +
  "their details were not recorded, and ask them to call back in a few minutes.";

const runToolCall = async (call, callId) => {
  const name = call.name ?? call.function?.name;
  const raw = call.arguments ?? call.function?.arguments ?? {};
  const args = typeof raw === "string" ? JSON.parse(raw) : raw;

  log.info("tool.called", { call_id: callId, name, args });

  const handler = handlers[name];
  if (!handler) return { toolCallId: call.id, result: `Unknown tool "${name}".` };

  try {
    return { toolCallId: call.id, result: await handler(args, { callId }) };
  } catch (error) {
    log.error("tool.failed", { call_id: callId, name, error: error.message });
    return { toolCallId: call.id, result: UNAVAILABLE };
  }
};

const onEndOfCall = async (message) => {
  const callId = message.call?.id;
  const transcript = message.transcript ?? message.artifact?.transcript;

  log.info("call.ended", {
    call_id: callId,
    reason: message.endedReason,
    duration_seconds: message.durationSeconds,
    transcript,
  });

  if (callId && transcript) await service.attachTranscript(callId, transcript);
};

vapiRouter.post("/webhook", async (req, res) => {
  if (!authorised(req)) return res.status(401).json({ data: null, error: { message: "Unauthorized" } });

  const message = req.body?.message ?? {};
  const callId = message.call?.id;

  try {
    if (message.type === "end-of-call-report") {
      await onEndOfCall(message);
      return res.json({ received: true });
    }

    if (message.type !== "tool-calls") return res.json({ received: true });

    const calls = message.toolCallList ?? message.toolCalls ?? [];
    const results = await Promise.all(calls.map((call) => runToolCall(call, callId)));
    return res.json({ results });
  } catch (error) {
    log.error("webhook.failed", { call_id: callId, type: message.type, error: error.message });
    return res.json({ results: [{ toolCallId: req.body?.message?.toolCallList?.[0]?.id, result: UNAVAILABLE }] });
  }
});
