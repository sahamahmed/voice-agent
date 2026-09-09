import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

let baseUrl;
let server;
const created = [];

const api = async (path, options = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return { status: response.status, body: await response.json() };
};

const validPatient = (overrides = {}) => ({
  first_name: "Test",
  last_name: "Patient",
  date_of_birth: "04/18/1990",
  sex: "Female",
  phone_number: `213555${String(Math.floor(1000 + Math.random() * 8999))}`,
  address_line_1: "1 Test Street",
  city: "Los Angeles",
  state: "CA",
  zip_code: "90012",
  ...overrides,
});

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (created.length) {
    await prisma.patient.deleteMany({ where: { patientId: { in: created } } });
  }
  await prisma.$disconnect();
  server.close();
});

const createPatient = async (overrides) => {
  const { status, body } = await api("/patients", { method: "POST", body: validPatient(overrides) });
  assert.equal(status, 201);
  created.push(body.data.patient_id);
  return body.data;
};

describe("POST /patients", () => {
  test("creates a patient and returns 201 with a patient_id", async () => {
    const patient = await createPatient({ first_name: "Ada" });
    assert.match(patient.patient_id, /^[0-9a-f-]{36}$/);
    assert.equal(patient.first_name, "Ada");
    assert.equal(patient.deleted_at, null);
  });

  test("rejects a future date of birth with 422 naming the field", async () => {
    const { status, body } = await api("/patients", {
      method: "POST",
      body: validPatient({ date_of_birth: "01/01/2099" }),
    });
    assert.equal(status, 422);
    assert.equal(body.data, null);
    assert.ok(body.error.details.some((d) => d.field === "date_of_birth"));
  });

  test("rejects a date that does not exist on the calendar", async () => {
    const { status, body } = await api("/patients", {
      method: "POST",
      body: validPatient({ date_of_birth: "02/30/1990" }),
    });
    assert.equal(status, 422);
    assert.ok(body.error.details.some((d) => d.field === "date_of_birth"));
  });

  test("rejects a phone number that is not 10 digits", async () => {
    const { status, body } = await api("/patients", {
      method: "POST",
      body: validPatient({ phone_number: "213" }),
    });
    assert.equal(status, 422);
    assert.ok(body.error.details.some((d) => d.field === "phone_number"));
  });

  test("reports every invalid field at once, not just the first", async () => {
    const { status, body } = await api("/patients", {
      method: "POST",
      body: validPatient({ phone_number: "1", zip_code: "9", state: "ZZ" }),
    });
    assert.equal(status, 422);
    const fields = body.error.details.map((d) => d.field);
    assert.ok(["phone_number", "zip_code", "state"].every((f) => fields.includes(f)));
  });

  test("normalises speech-shaped input into stored values", async () => {
    const patient = await createPatient({
      state: "California",
      phone_number: "(213) 555-0188",
      date_of_birth: "1990-04-18",
      insurance_provider: "none",
    });
    assert.equal(patient.state, "CA");
    assert.equal(patient.phone_number, "2135550188");
    assert.equal(patient.date_of_birth, "1990-04-18");
    assert.equal(patient.insurance_provider, null);
  });

  test("defaults preferred_language to English", async () => {
    const patient = await createPatient();
    assert.equal(patient.preferred_language, "English");
  });
});

describe("GET /patients", () => {
  test("filters by last_name", async () => {
    const unique = `Filter${Math.random().toString(36).replace(/[^a-z]/g, "").slice(0, 8) || "abcdefgh"}`;
    await createPatient({ last_name: unique });
    const { status, body } = await api(`/patients?last_name=${unique}`);
    assert.equal(status, 200);
    assert.equal(body.data.total, 1);
    assert.equal(body.data.patients[0].last_name, unique);
  });

  test("filters by phone_number regardless of formatting", async () => {
    const patient = await createPatient({ phone_number: "2135550143" });
    const { body } = await api("/patients?phone_number=(213) 555-0143");
    assert.ok(body.data.patients.some((p) => p.patient_id === patient.patient_id));
  });

  test("rejects an unparseable date_of_birth filter with 400", async () => {
    const { status } = await api("/patients?date_of_birth=not-a-date");
    assert.equal(status, 400);
  });
});

describe("GET /patients/:id", () => {
  test("returns the patient", async () => {
    const patient = await createPatient();
    const { status, body } = await api(`/patients/${patient.patient_id}`);
    assert.equal(status, 200);
    assert.equal(body.data.patient_id, patient.patient_id);
  });

  test("returns 404 for a well-formed but unknown id", async () => {
    const { status } = await api("/patients/00000000-0000-0000-0000-000000000000");
    assert.equal(status, 404);
  });

  test("returns 400 for an id that is not a UUID", async () => {
    const { status } = await api("/patients/not-a-uuid");
    assert.equal(status, 400);
  });
});

describe("PUT /patients/:id", () => {
  test("applies a partial update without clearing other fields", async () => {
    const patient = await createPatient({ city: "Los Angeles" });
    const { status, body } = await api(`/patients/${patient.patient_id}`, {
      method: "PUT",
      body: { city: "Pasadena" },
    });
    assert.equal(status, 200);
    assert.equal(body.data.city, "Pasadena");
    assert.equal(body.data.first_name, patient.first_name);
    assert.equal(body.data.zip_code, patient.zip_code);
  });

  test("validates updated fields with the same rules as create", async () => {
    const patient = await createPatient();
    const { status } = await api(`/patients/${patient.patient_id}`, {
      method: "PUT",
      body: { date_of_birth: "01/01/2099" },
    });
    assert.equal(status, 422);
  });

  test("rejects an empty update with 400", async () => {
    const patient = await createPatient();
    const { status } = await api(`/patients/${patient.patient_id}`, { method: "PUT", body: {} });
    assert.equal(status, 400);
  });
});

describe("DELETE /patients/:id", () => {
  test("soft-deletes: sets deleted_at and hides the record from reads", async () => {
    const patient = await createPatient();

    const { status, body } = await api(`/patients/${patient.patient_id}`, { method: "DELETE" });
    assert.equal(status, 200);
    assert.notEqual(body.data.deleted_at, null);

    const afterGet = await api(`/patients/${patient.patient_id}`);
    assert.equal(afterGet.status, 404);

    const row = await prisma.patient.findUnique({ where: { patientId: patient.patient_id } });
    assert.ok(row, "row must still exist in the database — soft delete, not hard delete");
  });
});

describe("POST /vapi/webhook", () => {
  const secret = process.env.VAPI_SECRET;

  const toolCall = (name, args, callId = `test-${Date.now()}-${Math.random()}`) => ({
    method: "POST",
    headers: secret ? { "x-vapi-secret": secret } : {},
    body: { message: { type: "tool-calls", call: { id: callId }, toolCallList: [{ id: "tc1", name, arguments: args }] } },
  });

  test("rejects a request without the shared secret", { skip: !secret }, async () => {
    const { status } = await api("/vapi/webhook", {
      method: "POST",
      headers: { "x-vapi-secret": "wrong" },
      body: {},
    });
    assert.equal(status, 401);
  });

  test("lookup_patient reports a miss as a new registration", async () => {
    const { body } = await api("/vapi/webhook", toolCall("lookup_patient", { phone_number: "2135559999" }));
    assert.match(body.results[0].result, /new registration/i);
  });

  test("lookup_patient finds an existing record by phone", async () => {
    const patient = await createPatient({ phone_number: "2135550175", first_name: "Returning" });
    const { body } = await api("/vapi/webhook", toolCall("lookup_patient", { phone_number: "2135550175" }));
    assert.match(body.results[0].result, /EXISTING RECORD FOUND/);
    assert.match(body.results[0].result, new RegExp(patient.patient_id));
  });

  test("register_patient saves and returns the patient_id to the agent", async () => {
    const callId = `test-reg-${Date.now()}`;
    const { body } = await api("/vapi/webhook", toolCall("register_patient", validPatient({ first_name: "Voice" }), callId));

    assert.match(body.results[0].result, /^SAVED\./);
    const [, id] = body.results[0].result.match(/patient_id: ([0-9a-f-]{36})/);
    created.push(id);

    const stored = await prisma.patient.findUnique({ where: { patientId: id } });
    assert.equal(stored.firstName, "Voice");
    assert.equal(stored.vapiCallId, callId);
  });

  test("register_patient refuses invalid data and tells the agent which fields to re-ask", async () => {
    const { body } = await api(
      "/vapi/webhook",
      toolCall("register_patient", validPatient({ date_of_birth: "01/01/2099", phone_number: "1" })),
    );
    const result = body.results[0].result;
    assert.match(result, /^NOT SAVED/);
    assert.match(result, /date_of_birth/);
    assert.match(result, /phone_number/);
    assert.doesNotMatch(result, /SAVED\. patient_id/);
  });

  test("an unknown tool name does not crash the webhook", async () => {
    const { status, body } = await api("/vapi/webhook", toolCall("no_such_tool", {}));
    assert.equal(status, 200);
    assert.match(body.results[0].result, /Unknown tool/);
  });

  test("end-of-call-report stores the transcript against the call", async () => {
    const callId = `test-eoc-${Date.now()}`;
    const { body } = await api("/vapi/webhook", toolCall("register_patient", validPatient(), callId));
    const [, id] = body.results[0].result.match(/patient_id: ([0-9a-f-]{36})/);
    created.push(id);

    await api("/vapi/webhook", {
      method: "POST",
      headers: secret ? { "x-vapi-secret": secret } : {},
      body: {
        message: {
          type: "end-of-call-report",
          call: { id: callId, customer: { number: "+12135550100" } },
          endedReason: "customer-ended-call",
          durationSeconds: 90,
          transcript: "AI: Hello.\nUser: Hi.",
        },
      },
    });

    const callLog = await prisma.callLog.findUnique({ where: { vapiCallId: callId } });
    assert.equal(callLog.transcript, "AI: Hello.\nUser: Hi.");
    assert.equal(callLog.patientId, id);

    const patient = await prisma.patient.findUnique({ where: { patientId: id } });
    assert.equal(patient.callTranscript, "AI: Hello.\nUser: Hi.");

    await prisma.callLog.delete({ where: { vapiCallId: callId } });
  });
});
