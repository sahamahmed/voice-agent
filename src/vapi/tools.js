import { createPatientSchema, updatePatientSchema, formatIssues, normalisePhone } from "../patients/schema.js";
import * as patients from "../patients/service.js";
import * as calls from "../calls/service.js";
import { log } from "../log.js";

const describe = (p) =>
  `${p.firstName} ${p.lastName}, born ${p.dateOfBirth.toISOString().slice(0, 10)}, ` +
  `phone ${p.phoneNumber}, ${p.addressLine1}${p.addressLine2 ? `, ${p.addressLine2}` : ""}, ` +
  `${p.city}, ${p.state} ${p.zipCode}`;

const rejection = (issues, retryWith) =>
  `NOT SAVED. These fields are invalid: ${issues.map((i) => `${i.field} (${i.message})`).join("; ")}. ` +
  `Ask the caller only about those fields, then call ${retryWith} again with the complete set.`;

export const UNAVAILABLE =
  "The system is temporarily unavailable and nothing was saved. Apologise, tell the caller " +
  "their details were not recorded, and ask them to call back in a few minutes.";

const lookupPatient = async ({ phone_number }) => {
  if (!phone_number) return "No phone number available. Continue as a new registration.";

  const existing = await patients.findByPhone(normalisePhone(phone_number));
  if (!existing) return "No existing record. Continue as a new registration.";

  return (
    `EXISTING RECORD FOUND. patient_id: ${existing.patientId}. On file: ${describe(existing)}. ` +
    `Greet them by name, say you already have their record, and ask whether they want to update it ` +
    `or register as a new patient.`
  );
};

const registerPatient = async (args, { callId }) => {
  const parsed = createPatientSchema.safeParse(args ?? {});
  if (!parsed.success) {
    const issues = formatIssues(parsed.error);
    log.warn("registration.rejected", { call_id: callId, issues });
    return rejection(issues, "register_patient");
  }

  const patient = await patients.createPatient({ ...parsed.data, vapi_call_id: callId });
  log.info("registration.saved", { call_id: callId, patient: patients.toApi(patient) });
  if (callId) await calls.linkPatient(callId, patient.patientId);

  return (
    `SAVED. patient_id: ${patient.patientId}. Tell ${patient.firstName} they are all set ` +
    `and that their registration is complete, then end the call.`
  );
};

const updatePatient = async ({ patient_id, ...fields }, { callId }) => {
  if (!patient_id) return "No patient_id. Call lookup_patient first.";

  const parsed = updatePatientSchema.safeParse(fields ?? {});
  if (!parsed.success) return rejection(formatIssues(parsed.error), "update_patient");

  const patient = await patients.updatePatient(patient_id, parsed.data);
  if (!patient) return "No patient with that patient_id. Register them as a new patient instead.";

  log.info("registration.updated", { call_id: callId, patient: patients.toApi(patient) });
  if (callId) await calls.linkPatient(callId, patient.patientId);

  return `UPDATED. Tell ${patient.firstName} their information is up to date, then end the call.`;
};

export const toolHandlers = {
  lookup_patient: lookupPatient,
  register_patient: registerPatient,
  update_patient: updatePatient,
};
