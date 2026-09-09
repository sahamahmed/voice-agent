import { createPatientSchema, updatePatientSchema, formatIssues, normalisePhone } from "../patients/schema.js";
import * as patients from "../patients/service.js";
import * as calls from "../calls/service.js";
import { log } from "../log.js";

const describe = (p) =>
  `${p.firstName} ${p.lastName}, born ${p.dateOfBirth.toISOString().slice(0, 10)}, ` +
  `phone ${p.phoneNumber}, ${p.addressLine1}${p.addressLine2 ? `, ${p.addressLine2}` : ""}, ` +
  `${p.city}, ${p.state} ${p.zipCode}`;

const SPOKEN_FIELD = {
  first_name: "first name",
  last_name: "last name",
  date_of_birth: "date of birth",
  phone_number: "phone number",
  address_line_1: "street address",
  address_line_2: "apartment or unit",
  zip_code: "ZIP code",
  insurance_provider: "insurance provider",
  insurance_member_id: "member ID",
  preferred_language: "preferred language",
  emergency_contact_name: "emergency contact",
  emergency_contact_phone: "emergency contact number",
};

const spokenList = (items) =>
  items.length <= 1 ? (items[0] ?? "details") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

const rejection = (issues, retryWith) =>
  `NOT SAVED. These fields are invalid: ${issues.map((i) => `${i.field} (${i.message})`).join("; ")}. ` +
  `Ask the caller only about those fields, then call ${retryWith} again with the complete set.`;

export const UNAVAILABLE =
  "The system is temporarily unavailable and nothing was saved. Apologise, tell the caller " +
  "their details were not recorded, and ask them to call back in a few minutes.";

const found = (existing) =>
  `EXISTING RECORD FOUND. patient_id: ${existing.patientId}. On file: ${describe(existing)}. ` +
  `Greet them by name, say you already have their record, and ask whether they want to update it ` +
  `or register as a new patient.`;

const lookupPatient = async ({ phone_number }) => {
  if (!phone_number) return "No phone number available. Continue as a new registration.";

  const existing = await patients.findByPhone(normalisePhone(phone_number));
  if (existing) return found(existing);

  for (const id of await calls.findPatientIdsByCaller(phone_number)) {
    const previous = await patients.getPatient(id);
    if (previous) return found(previous);
  }

  return "No existing record. Continue as a new registration.";
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
    `SAVED. patient_id: ${patient.patientId}. Before anything else, say out loud to the caller: ` +
    `"You're all set, ${patient.firstName} — you're registered with us and we'll see you soon." ` +
    `Wait for them to reply. Only then say goodbye and use endCall. Do not use endCall in this same turn.`
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

  const changed = spokenList(Object.keys(parsed.data).map((f) => SPOKEN_FIELD[f] ?? f.replace(/_/g, " ")));

  return (
    `UPDATED (${changed}). Before anything else, say out loud to the caller: ` +
    `"That's all updated, ${patient.firstName} — I've got your new ${changed} on file." ` +
    `Then ask if there is anything else they would like to change. Only once they say no ` +
    `should you say goodbye and use endCall. Do not use endCall in this same turn.`
  );
};

export const toolHandlers = {
  lookup_patient: lookupPatient,
  register_patient: registerPatient,
  update_patient: updatePatient,
};
