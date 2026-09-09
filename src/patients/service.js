import { prisma } from "../db.js";

const toDb = (input) => ({
  firstName: input.first_name,
  lastName: input.last_name,
  dateOfBirth: input.date_of_birth,
  sex: input.sex,
  phoneNumber: input.phone_number,
  email: input.email,
  addressLine1: input.address_line_1,
  addressLine2: input.address_line_2,
  city: input.city,
  state: input.state,
  zipCode: input.zip_code,
  insuranceProvider: input.insurance_provider,
  insuranceMemberId: input.insurance_member_id,
  preferredLanguage: input.preferred_language,
  emergencyContactName: input.emergency_contact_name,
  emergencyContactPhone: input.emergency_contact_phone,
  vapiCallId: input.vapi_call_id,
  callTranscript: input.call_transcript,
});

const definedOnly = (obj) =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

export const toApi = (p) =>
  p && {
    patient_id: p.patientId,
    first_name: p.firstName,
    last_name: p.lastName,
    date_of_birth: p.dateOfBirth.toISOString().slice(0, 10),
    sex: p.sex,
    phone_number: p.phoneNumber,
    email: p.email,
    address_line_1: p.addressLine1,
    address_line_2: p.addressLine2,
    city: p.city,
    state: p.state,
    zip_code: p.zipCode,
    insurance_provider: p.insuranceProvider,
    insurance_member_id: p.insuranceMemberId,
    preferred_language: p.preferredLanguage,
    emergency_contact_name: p.emergencyContactName,
    emergency_contact_phone: p.emergencyContactPhone,
    created_at: p.createdAt.toISOString(),
    updated_at: p.updatedAt.toISOString(),
    deleted_at: p.deletedAt ? p.deletedAt.toISOString() : null,
  };

export const createPatient = (input) => prisma.patient.create({ data: toDb(input) });

export const getPatient = (patientId) =>
  prisma.patient.findFirst({ where: { patientId, deletedAt: null } });

export const listPatients = async ({ last_name, date_of_birth, phone_number, limit, offset }) => {
  const where = { deletedAt: null };
  if (last_name) where.lastName = { equals: last_name, mode: "insensitive" };
  if (phone_number) where.phoneNumber = phone_number;
  if (date_of_birth) where.dateOfBirth = date_of_birth;

  const [rows, total] = await Promise.all([
    prisma.patient.findMany({ where, orderBy: { createdAt: "desc" }, take: limit, skip: offset }),
    prisma.patient.count({ where }),
  ]);
  return { rows, total };
};

export const findByPhone = (phoneNumber) =>
  prisma.patient.findFirst({
    where: { phoneNumber, deletedAt: null },
    orderBy: { createdAt: "desc" },
  });

export const updatePatient = async (patientId, input) => {
  const existing = await getPatient(patientId);
  if (!existing) return null;
  return prisma.patient.update({ where: { patientId }, data: definedOnly(toDb(input)) });
};

export const softDeletePatient = async (patientId) => {
  const existing = await getPatient(patientId);
  if (!existing) return null;
  return prisma.patient.update({ where: { patientId }, data: { deletedAt: new Date() } });
};

export const attachTranscript = (vapiCallId, callTranscript) =>
  prisma.patient.updateMany({ where: { vapiCallId }, data: { callTranscript } });
