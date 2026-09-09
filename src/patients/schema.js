import { z } from "zod";

const STATES = {
  AL: "alabama", AK: "alaska", AZ: "arizona", AR: "arkansas", CA: "california",
  CO: "colorado", CT: "connecticut", DE: "delaware", FL: "florida", GA: "georgia",
  HI: "hawaii", ID: "idaho", IL: "illinois", IN: "indiana", IA: "iowa",
  KS: "kansas", KY: "kentucky", LA: "louisiana", ME: "maine", MD: "maryland",
  MA: "massachusetts", MI: "michigan", MN: "minnesota", MS: "mississippi",
  MO: "missouri", MT: "montana", NE: "nebraska", NV: "nevada",
  NH: "new hampshire", NJ: "new jersey", NM: "new mexico", NY: "new york",
  NC: "north carolina", ND: "north dakota", OH: "ohio", OK: "oklahoma",
  OR: "oregon", PA: "pennsylvania", RI: "rhode island", SC: "south carolina",
  SD: "south dakota", TN: "tennessee", TX: "texas", UT: "utah", VT: "vermont",
  VA: "virginia", WA: "washington", WV: "west virginia", WI: "wisconsin",
  WY: "wyoming", DC: "district of columbia",
};

const normaliseState = (raw) => {
  const s = String(raw).trim().toLowerCase();
  if (s.length === 2 && STATES[s.toUpperCase()]) return s.toUpperCase();
  const hit = Object.entries(STATES).find(([, name]) => name === s);
  return hit ? hit[0] : String(raw).trim().toUpperCase();
};

const normalisePhone = (raw) => {
  const d = String(raw).replace(/\D/g, "");
  return d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
};

const parseDob = (raw) => {
  const s = String(raw).trim();
  const us = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  let y, m, d;
  if (us) [, m, d, y] = us;
  else if (iso) [, y, m, d] = iso;
  else return null;
  const date = new Date(Date.UTC(+y, +m - 1, +d));
  const valid =
    date.getUTCFullYear() === +y &&
    date.getUTCMonth() === +m - 1 &&
    date.getUTCDate() === +d;
  return valid ? date : null;
};

const name = (label) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .max(50, `${label} must be 50 characters or fewer`)
    .regex(/^[A-Za-z][A-Za-z'\- ]*$/, `${label} may only contain letters, hyphens and apostrophes`);

const phone = (label) =>
  z
    .string()
    .transform(normalisePhone)
    .refine((v) => /^[2-9]\d{9}$/.test(v), {
      message: `${label} must be a valid 10-digit U.S. phone number`,
    });

const dateOfBirth = z
  .string()
  .transform((v, ctx) => {
    const parsed = parseDob(v);
    if (!parsed) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Date of birth must be a real date in MM/DD/YYYY format" });
      return z.NEVER;
    }
    if (parsed.getTime() > Date.now()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Date of birth cannot be in the future" });
      return z.NEVER;
    }
    if (parsed.getUTCFullYear() < 1900) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Date of birth must be after 1900" });
      return z.NEVER;
    }
    return parsed;
  });

const optionalText = (max) =>
  z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => {
      if (v == null) return undefined;
      const s = String(v).trim();
      return s === "" || /^(none|n\/?a|null|skip|no)$/i.test(s) ? undefined : s;
    })
    .refine((v) => v === undefined || v.length <= max, `Must be ${max} characters or fewer`);

const patientFields = z.object({
  first_name: name("First name"),
  last_name: name("Last name"),
  date_of_birth: dateOfBirth,
  sex: z.enum(["Male", "Female", "Other", "DeclineToAnswer"], {
    errorMap: () => ({ message: "Sex must be Male, Female, Other or DeclineToAnswer" }),
  }),
  phone_number: phone("Phone number"),
  email: optionalText(254).refine(
    (v) => v === undefined || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v),
    "Email must be a valid email address",
  ),

  address_line_1: z.string().trim().min(1, "Street address is required").max(200),
  address_line_2: optionalText(200),
  city: z.string().trim().min(1, "City is required").max(100),
  state: z
    .string()
    .transform(normaliseState)
    .refine((v) => v in STATES, "State must be a valid 2-letter U.S. state abbreviation"),
  zip_code: z
    .string()
    .transform((v) => String(v).replace(/[^\d-]/g, ""))
    .refine((v) => /^\d{5}(-\d{4})?$/.test(v), "ZIP code must be 5 digits, or ZIP+4"),

  insurance_provider: optionalText(100),
  insurance_member_id: optionalText(50).refine(
    (v) => v === undefined || /^[A-Za-z0-9-]+$/.test(v),
    "Insurance member ID must be alphanumeric",
  ),
  preferred_language: optionalText(50),
  emergency_contact_name: optionalText(100),
  emergency_contact_phone: phone("Emergency contact phone").optional().or(z.literal("").transform(() => undefined)),
  call_transcript: optionalText(100000),
});

const pairedInsurance = (data, ctx) => {
  if (data.insurance_member_id && !data.insurance_provider) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["insurance_provider"],
      message: "Insurance provider is required when a member ID is given",
    });
  }
};

export const createPatientSchema = patientFields.superRefine(pairedInsurance);
export const updatePatientSchema = patientFields.partial().superRefine(pairedInsurance);

export const listQuerySchema = z.object({
  last_name: z.string().trim().min(1).optional(),
  date_of_birth: z.string().trim().min(1).optional(),
  phone_number: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const formatIssues = (error) =>
  error.issues.map((i) => ({ field: i.path.join(".") || "body", message: i.message }));

export { normalisePhone, normaliseState, parseDob };
