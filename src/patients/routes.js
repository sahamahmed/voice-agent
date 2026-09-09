import { Router } from "express";
import { ok, fail, wrap } from "../http.js";
import { createPatientSchema, updatePatientSchema, listQuerySchema, formatIssues, parseDob } from "./schema.js";
import * as service from "./service.js";

export const patientsRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

patientsRouter.get(
  "/",
  wrap(async (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) return fail(res, 400, "Invalid query parameters", formatIssues(parsed.error));

    const query = { ...parsed.data };
    if (query.phone_number) query.phone_number = query.phone_number.replace(/\D/g, "").slice(-10);
    if (query.date_of_birth) {
      const dob = parseDob(query.date_of_birth);
      if (!dob) return fail(res, 400, "Invalid query parameters", [{ field: "date_of_birth", message: "Must be MM/DD/YYYY or YYYY-MM-DD" }]);
      query.date_of_birth = dob;
    }

    const { rows, total } = await service.listPatients(query);
    return ok(res, { patients: rows.map(service.toApi), total, limit: query.limit, offset: query.offset });
  }),
);

patientsRouter.get(
  "/:id",
  wrap(async (req, res) => {
    if (!UUID.test(req.params.id)) return fail(res, 400, "patient_id must be a UUID");
    const patient = await service.getPatient(req.params.id);
    if (!patient) return fail(res, 404, "Patient not found");
    return ok(res, service.toApi(patient));
  }),
);

patientsRouter.post(
  "/",
  wrap(async (req, res) => {
    const parsed = createPatientSchema.safeParse(req.body ?? {});
    if (!parsed.success) return fail(res, 422, "Validation failed", formatIssues(parsed.error));
    const patient = await service.createPatient(parsed.data);
    return ok(res, service.toApi(patient), 201);
  }),
);

patientsRouter.put(
  "/:id",
  wrap(async (req, res) => {
    if (!UUID.test(req.params.id)) return fail(res, 400, "patient_id must be a UUID");
    const parsed = updatePatientSchema.safeParse(req.body ?? {});
    if (!parsed.success) return fail(res, 422, "Validation failed", formatIssues(parsed.error));
    if (Object.keys(parsed.data).length === 0) return fail(res, 400, "No fields to update");

    const patient = await service.updatePatient(req.params.id, parsed.data);
    if (!patient) return fail(res, 404, "Patient not found");
    return ok(res, service.toApi(patient));
  }),
);

patientsRouter.delete(
  "/:id",
  wrap(async (req, res) => {
    if (!UUID.test(req.params.id)) return fail(res, 400, "patient_id must be a UUID");
    const patient = await service.softDeletePatient(req.params.id);
    if (!patient) return fail(res, 404, "Patient not found");
    return ok(res, service.toApi(patient));
  }),
);
