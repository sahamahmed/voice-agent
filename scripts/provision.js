import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const API = "https://api.vapi.ai";
const ASSISTANT_NAME = "Riley — Patient Intake";

const here = dirname(fileURLToPath(import.meta.url));

const required = (key) => {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
};

const vapi = async (method, path, body) => {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${required("VAPI_PRIVATE_KEY")}`,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}\n${text}`);
  return text ? JSON.parse(text) : null;
};

const field = (description, extra = {}) => ({ type: "string", description, ...extra });

const PATIENT_FIELDS = {
  first_name: field("Given name, letters only"),
  last_name: field("Family name, letters only"),
  date_of_birth: field("Date of birth as MM/DD/YYYY"),
  sex: field("How the caller wants their sex recorded", {
    enum: ["Male", "Female", "Other", "DeclineToAnswer"],
  }),
  phone_number: field("10-digit US phone number, digits only"),
  email: field("Email address, if the caller offered one"),
  address_line_1: field("Street address including house or building number"),
  address_line_2: field("Apartment, suite or unit, if any"),
  city: field("City name"),
  state: field("US state, either the full name or the 2-letter abbreviation"),
  zip_code: field("5-digit ZIP code, or ZIP+4"),
  insurance_provider: field("Insurance company name, if offered"),
  insurance_member_id: field("Insurance member or subscriber ID, if offered"),
  preferred_language: field("Preferred spoken language, if offered"),
  emergency_contact_name: field("Emergency contact full name, if offered"),
  emergency_contact_phone: field("Emergency contact 10-digit US phone number, if offered"),
};

const REQUIRED_FIELDS = [
  "first_name",
  "last_name",
  "date_of_birth",
  "sex",
  "phone_number",
  "address_line_1",
  "city",
  "state",
  "zip_code",
];

const tool = (name, description, properties, requiredKeys, serverUrl, secret) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required: requiredKeys } },
  server: { url: serverUrl, secret },
});

const buildTools = (serverUrl, secret) => [
  tool(
    "lookup_patient",
    "Check whether a patient record already exists for a phone number. Call this once at the very start of every call, before speaking, using the number the caller is calling from.",
    { phone_number: field("The caller's 10-digit phone number") },
    ["phone_number"],
    serverUrl,
    secret,
  ),
  tool(
    "register_patient",
    "Save a new patient record. Call this only after the caller has confirmed the read-back. Include every field collected during the call.",
    PATIENT_FIELDS,
    REQUIRED_FIELDS,
    serverUrl,
    secret,
  ),
  { type: "endCall" },
  tool(
    "update_patient",
    "Update an existing patient record found by lookup_patient. Send patient_id plus only the fields that changed.",
    { patient_id: field("The patient_id returned by lookup_patient"), ...PATIENT_FIELDS },
    ["patient_id"],
    serverUrl,
    secret,
  ),
];

const buildAssistant = (systemPrompt, serverUrl, secret) => ({
  name: ASSISTANT_NAME,
  firstMessage: "Thanks for calling Northside Family Clinic, this is Riley. Am I speaking with someone who'd like to register as a patient?",
  firstMessageMode: "assistant-speaks-first",
  maxDurationSeconds: 300,
  silenceTimeoutSeconds: 20,
  backgroundSound: "off",
  model: {
    provider: "openai",
    model: "gpt-4o",
    temperature: 0.3,
    messages: [{ role: "system", content: systemPrompt }],
    tools: buildTools(serverUrl, secret),
  },
  voice: { provider: "vapi", voiceId: "Elliot" },
  transcriber: {
    provider: "deepgram",
    model: "nova-3",
    language: "en",
    smartFormat: true,
    keyterm: [
      "date of birth", "ZIP code", "insurance", "member ID", "emergency contact",
      "Aetna", "Cigna", "Humana", "Kaiser", "Blue Cross", "Blue Shield", "UnitedHealthcare",
      "decline to answer", "apartment", "suite",
    ],
  },
  startSpeakingPlan: { waitSeconds: 0.8 },
  stopSpeakingPlan: { numWords: 3 },
  serverMessages: ["tool-calls", "end-of-call-report"],
  server: { url: serverUrl, secret },
  endCallFunctionEnabled: true,
  analysisPlan: { summaryPlan: { enabled: true } },
});

const findByName = async (name) => {
  const assistants = await vapi("GET", "/assistant?limit=100");
  return assistants.find((a) => a.name === name) ?? null;
};

const attachToPhoneNumber = async (assistantId, wantedNumber) => {
  const numbers = await vapi("GET", "/phone-number");
  const match = numbers.find((n) => n.number === wantedNumber) ?? numbers[0];
  if (!match) throw new Error("No phone number found on this Vapi account");

  await vapi("PATCH", `/phone-number/${match.id}`, { assistantId });
  return match.number;
};

const main = async () => {
  const serverUrl = `${required("PUBLIC_BASE_URL").replace(/\/$/, "")}/vapi/webhook`;
  const secret = required("VAPI_SECRET");

  const systemPrompt = await readFile(join(here, "..", "src", "vapi", "prompt.md"), "utf8");
  const payload = buildAssistant(systemPrompt, serverUrl, secret);

  const existing = await findByName(ASSISTANT_NAME);
  const assistant = existing
    ? await vapi("PATCH", `/assistant/${existing.id}`, payload)
    : await vapi("POST", "/assistant", payload);

  const number = await attachToPhoneNumber(assistant.id, process.env.VAPI_PHONE_NUMBER);

  console.log(existing ? "Updated assistant" : "Created assistant");
  console.log(`  id:      ${assistant.id}`);
  console.log(`  webhook: ${serverUrl}`);
  console.log(`  number:  ${number}`);
};

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
