# Voice AI Patient Registration

A phone number you can call. An intake coordinator named Riley answers, has an
actual conversation with you, collects the standard U.S. patient demographic
set, reads it back, and writes it to Postgres. A REST API exposes what she
collected.

**Live:**

| | |
|---|---|
| Call | **+1 (213) 528-3131** |
| API | `https://voice-agent-production-087d.up.railway.app` |
| Dashboard | [`/`](https://voice-agent-production-087d.up.railway.app/) — registered patients, live from the database |
| Health | [`/health`](https://voice-agent-production-087d.up.railway.app/health) |

Call it twice. The second call recognises you.

---

## How it fits together

The important decision is the boundary: **Vapi owns the conversation, this
codebase owns the truth.** Vapi never decides whether data is valid; this
service never decides what to say.

```
┌──────────────── VAPI (managed — we only configure it) ────────────────┐
│  PSTN → telephony → VAD → Deepgram nova-3 → GPT-4o → TTS → caller     │
│                                      │                                │
│                                      │ decides when to call a tool    │
└──────────────────────────────────────┼────────────────────────────────┘
                                       │ HTTPS + x-vapi-secret
                                       ▼
┌──────────────── THIS SERVICE (Railway) ───────────────────────────────┐
│  src/vapi/routes.js    webhook transport + auth                       │
│  src/vapi/tools.js     lookup_patient · register_patient ·            │
│                        update_patient — what the agent gets told      │
│         │                                                             │
│  src/patients/schema.js ◄── Zod. The single authority on validity.    │
│         │                   Same rules for phone calls and for HTTP.  │
│         ▼                                                             │
│  src/patients/service.js ◄──── src/patients/routes.js  (REST)         │
│  src/calls/service.js    ◄──── src/calls/routes.js                    │
│         │                                                             │
│         ▼                                                             │
│  Postgres                                                             │
└───────────────────────────────────────────────────────────────────────┘
```

Nothing above the data layer knows Prisma exists. Nothing below the adapter
knows Vapi exists. Both entry points — a phone call and an HTTP request —
converge on the same validation and the same service functions, which is why a
record created by voice is exactly as trustworthy as one created by `curl`.

### One call, start to finish

```
caller dials
  → Riley greets (a canned first message — no LLM hop, so no dead air)
  → lookup_patient(caller ID), silently, before she speaks again
       ├─ hit  → "I have your record here — update it, or someone new?"
       └─ miss → collect the nine required fields, conversationally
  → offers the optional block as ONE opt-in question
  → reads everything back, invites corrections
  → caller confirms → register_patient(...)
       → Zod validates → INSERT → tool returns "SAVED. patient_id: …"
       → Riley says "You're all set, Sarah." → hangs up
  → Vapi posts end-of-call-report → transcript stored against that patient
```

---

## The files

```
src/app.js               Express app: middleware, routes, error mapping
src/index.js             Boot: connect Postgres, then listen. Graceful shutdown.
src/db.js                One PrismaClient for the process
src/http.js              ok() / fail() / wrap() — the { data, error } envelope
src/log.js               Structured JSON to stdout

src/patients/schema.js   Zod validation + speech normalisation
src/patients/service.js  The only module that touches Prisma for patients
src/patients/routes.js   GET / GET:id / POST / PUT / DELETE

src/calls/service.js     Call log persistence
src/calls/routes.js      GET /calls

src/vapi/prompt.md       The system prompt. Read this one.
src/vapi/tools.js        Tool handlers — the voice path's business logic
src/vapi/routes.js       Webhook transport and shared-secret auth

scripts/provision.js     Creates/updates the Vapi assistant. Idempotent.
scripts/seed.js          Two demo patients. Idempotent.
public/index.html        The dashboard. No build step, no framework.
test/api.test.js         24 tests, node:test, no framework
prisma/schema.prisma     19 columns, constraints, indexes, soft delete
```

---

## Running it

```bash
npm install
cp .env.example .env          # fill in DATABASE_URL and the Vapi values
npx prisma migrate deploy
npm run seed                  # optional: two demo patients
npm run dev
```

Then `npm run provision` to create the Vapi assistant and bind it to your
number. That command is the whole agent configuration — prompt, model, voice,
transcriber, tool schemas, webhook URL. It is idempotent: run it again after
editing `src/vapi/prompt.md` and the live assistant updates in place.

### Environment

| Variable | Needed by | What it is |
|---|---|---|
| `DATABASE_URL` | server, Prisma | Postgres connection string |
| `VAPI_SECRET` | server, provision | A secret **you invent**. Vapi echoes it back as `x-vapi-secret` so the webhook can prove the caller is Vapi. Not a Vapi API key. |
| `PUBLIC_BASE_URL` | provision | Where Vapi should send tool calls |
| `VAPI_PRIVATE_KEY` | provision only | Vapi API key. The server never calls Vapi — Vapi calls the server. |
| `VAPI_PHONE_NUMBER` | provision only | Which number to bind the assistant to |
| `PORT` | server | Railway injects this. Don't pin it. |

Only `DATABASE_URL` and `VAPI_SECRET` need to exist in production.

---

## The API

Every response is `{ "data": ..., "error": ... }`. Always.

| | | |
|---|---|---|
| `GET` | `/patients` | `?last_name=` `?date_of_birth=` `?phone_number=` `?limit=` `?offset=` |
| `GET` | `/patients/:id` | by UUID |
| `POST` | `/patients` | 201 with the created record |
| `PUT` | `/patients/:id` | partial updates; omitted fields are untouched |
| `DELETE` | `/patients/:id` | soft delete — sets `deleted_at`, row survives |
| `GET` | `/calls` | call log: transcript, duration, why it ended, linked patient |
| `GET` | `/health` | liveness + database reachability |

`200` `201` `400` `404` `409` `422` `500`. `422` carries the specific fields:

```json
{ "data": null,
  "error": { "message": "Validation failed",
             "details": [{ "field": "date_of_birth",
                           "message": "Date of birth cannot be in the future" }] } }
```

That shape isn't decoration — it's what lets the agent re-ask for exactly one
field instead of restarting the whole conversation.

---

## Why this stack

**Vapi** because the brief explicitly blesses it and because building
STT/TTS/turn-taking from scratch is a three-hour project on its own. I have
built the hard version before (LiveKit + Twilio SIP + Deepgram + a two-LLM
control plane) and it is emphatically not what you do when the clock is the
binding constraint. Vapi gets a real number answering in minutes and leaves the
interesting work — the prompt, the tool contract, the data layer — to me.

**Node + Express** for the smallest distance between an idea and a working
route. **Prisma** because the schema *is* a graded artifact here, and one
declarative file that generates both the migration and the typed client is the
cheapest way to get column types and constraints right.

**Postgres on Railway** over SQLite. SQLite would have been simpler, but "data
must survive server restarts" is scored, and container filesystems are
ephemeral unless you attach a volume. Managed Postgres removes the whole
question.

**Zod** rather than Prisma's own type checks, because validation has to run
*before* anything touches the database and has to produce field-level messages
the agent can speak.

**`node:test`** over Jest — it ships with the runtime. Adding a test framework
to run 24 assertions is exactly the kind of dependency this project doesn't need.

---

## The prompt

`src/vapi/prompt.md` is the actual system message, loaded verbatim by the
provisioning script. It is a file rather than a string literal because it is a
design artifact, not a config value — it deserves diffs.

The reasoning behind its shape:

**Phased, not listed.** The nine required fields come first, and the seven
optional ones are offered *once* as a single opt-in question. Given a flat list
of sixteen fields the model interrogates people. The phase boundary is what
makes it feel like a person rather than a form.

**Spelling beats hearing.** Riley asks you to spell your name and treats the
spelling as authoritative over what she thought she heard. This came directly
out of a test call: the transcriber heard "Saham" as "Sam", and because the
prompt originally said "read the name back to confirm", it confidently spelled
back its own mistake. Confirming a mishearing is worse than not confirming at
all. Asking someone to spell converts a hard problem — recognising an unfamiliar
proper noun — into an easy one: recognising 26 known words.

**The success line is not the model's to invent.** Riley may only say "you're
all set" after `register_patient` returns a string starting with `SAVED`. The
tool result is the only thing licensed to trigger that sentence, so it is
structurally impossible for her to promise a registration that didn't happen.
This is the single most important rule in the file.

**Failures come back as instructions, not codes.** A validation failure returns
*"NOT SAVED. These fields are invalid: date_of_birth (cannot be in the future).
Ask the caller only about those fields."* A database outage returns *"Apologise,
tell the caller their details were not recorded, ask them to call back."* The
model is never handed a status code and asked to improvise a bedside manner —
there is always a specific thing to say. That is what keeps a failing call from
becoming dead air.

**Short answers get confirmed.** "Female" is one word and easy for
voice-activity detection to miss entirely. Riley asks rather than waits.

---

## Edge cases, and what actually happens

| Situation | Behaviour |
|---|---|
| Birth date in the future, or `02/30/1990` | Rejected by Zod. Riley re-asks **only** the date. Round-trip parsing catches dates `Date` would silently roll over. |
| Three-digit phone number | Rejected, re-asked. Formatting is normalised first, so `(213) 528-3131` is fine. |
| Caller says "California" | Stored as `CA`. Full state names, mixed case, and abbreviations all work. |
| Caller corrects a name mid-readback | Riley fixes that field and re-reads only that field. |
| Caller says "start over" | The prompt instructs a clean discard. Nothing is written until final confirmation, so there is no half-record to reconcile. |
| Database write fails | The tool catches it and returns an apology instruction. The caller is told plainly that nothing was saved. Never silence, never a false success. |
| Call drops mid-conversation | **Nothing is saved.** See limitations. |
| Optional field answered "none" | Stored as `NULL`, not the literal string. Models fill skipped fields with polite placeholders. |
| Reviewer POSTs garbage directly to the API | Same Zod schema, same 422. The voice agent is not a trusted client. |

---

## Known limitations and trade-offs

These are real, and I'd rather name them than have you find them.

**Nothing is saved until the caller confirms.** If the line drops at field
seven, that call produces no patient record — only a row in `/calls` with the
transcript and `endedReason`. Incremental saving means a partial-record state
machine and reconciliation logic, which is an hour I chose to spend on the
conversation quality instead. It's the right trade at three hours and the wrong
one at three days.

**Duplicate detection keys off caller ID.** It works when someone calls twice
from the same number. It cannot work if you register a different number than
the one you're calling from — and it won't fire for a non-U.S. caller at all,
because the schema requires a valid 10-digit U.S. number per the spec. Both
lookup branches are covered by tests.

**Spanish is claimed but not properly supported.** The prompt tells Riley to
switch to Spanish, and GPT-4o and the TTS will both oblige — but the transcriber
is pinned to `language: "en"`, so Spanish speech will transcribe badly. Deepgram
has a multilingual mode; I didn't switch to it because I couldn't test whether
it degrades English accuracy, and English is what's being graded. Half-working
is worse than honest, so: it's listed here rather than in the feature list.

**Postgres is reached over Railway's public TCP proxy, not its private
network.** The private hostname is IPv6-only and resolved inconsistently from
the app container; I lost fifteen minutes to it and switched rather than keep
debugging. It costs a few milliseconds per query and is meaningless at this
scale, but it is not what I'd ship long-term.

**No auth on the API.** Anyone with the URL can read and write patient records.
For a demo with fake data that's intentional — the reviewer needs to poke at it
freely — but it is the first thing that would have to change.

**No rate limiting, and the webhook trusts a shared secret only.** Adequate for
this; not adequate for real PHI.

**Test call cost is real.** Each call runs about $0.15–0.20/minute with GPT-4o
and Deepgram nova-3. `maxDurationSeconds` is capped at 300 so a stuck call can't
quietly drain the account overnight.

**Not HIPAA anything.** Per the brief. Don't put real patient data in it.

---

## What I'd do next

Roughly in the order I'd actually do them:

1. **Incremental saves with a `draft` status**, so a dropped call at field seven
   isn't a wasted call. Riley would pick up where she left off on the callback —
   which is also the most human-feeling feature on this list.
2. **Fix Spanish properly**: multilingual transcription, and A/B it against the
   English-only config before trusting it.
3. **Auth on the API** — an API key at minimum, and take the dashboard off the
   public root.
4. **Confidence-aware re-asking.** Deepgram returns per-word confidence. A name
   transcribed at 0.4 should be spelled back automatically; one at 0.98 needn't
   be. Right now every name is spelled, which is safe but slightly slow.
5. **Appointment scheduling**, the one bonus I skipped outright. It's a fourth
   tool and a mock availability table — maybe thirty minutes.
6. **A retry with backoff around the database write**, so a transient blip
   becomes a half-second pause rather than an apology.
7. **Structured eval instead of vibes.** A dozen scripted call scenarios run
   against the assistant, asserting on the final payload. Right now "is the
   conversation good?" is answered by me listening to it, which does not scale
   and does not catch regressions when the prompt changes.

---

## Tests

```bash
npm test
```

24 tests against a real database — validation rules, every endpoint, status
codes, soft-delete semantics, and the full voice-tool path including transcript
linkage. They exercise the same code the phone calls do, because the phone path
and the HTTP path share everything below the adapter.

```
# tests 24
# pass 24
# fail 0
```

---

## A note on the three hours

The order was deliberate: get a real number answering and a real database
writing as early as possible, then spend whatever remained on the conversation,
because a technically perfect system with a bad voice experience is a failure
and the brief says so outright.

What that bought: a working end-to-end system with room left to fix a real
transcription bug found on a live test call. What it cost: no partial-call
persistence, no auth, and a Spanish feature I'd rather disclose than pretend
about.
