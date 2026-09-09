import { prisma } from "../db.js";

export const recordCall = (report) =>
  prisma.callLog.upsert({
    where: { vapiCallId: report.vapiCallId },
    create: report,
    update: report,
  });

export const linkPatient = (vapiCallId, patientId) =>
  prisma.callLog.upsert({
    where: { vapiCallId },
    create: { vapiCallId, patientId },
    update: { patientId },
  });

export const listCalls = (limit) =>
  prisma.callLog.findMany({ orderBy: { createdAt: "desc" }, take: limit });

export const toApi = (c) => ({
  vapi_call_id: c.vapiCallId,
  caller_number: c.callerNumber,
  ended_reason: c.endedReason,
  duration_seconds: c.durationSecs,
  summary: c.summary,
  transcript: c.transcript,
  patient_id: c.patientId,
  created_at: c.createdAt.toISOString(),
});

export const findPatientIdsByCaller = async (callerNumber) => {
  const previous = await prisma.callLog.findMany({
    where: { callerNumber, patientId: { not: null } },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  return previous.map((c) => c.patientId);
};
