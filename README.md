# Voice AI Patient Registration

Call **+1 (213) 528-3131** and an intake coordinator named Riley picks up. He'll
take your details the way a receptionist would, read them back, and save them to
Postgres. There's a REST API on top of the same data, and a small page that lists
what's been collected.

- API: `https://voice-agent-production-087d.up.railway.app`
- Dashboard: (https://voice-agent-production-087d.up.railway.app/)
- Health check: `/health`

If you call twice from the same number, the second call should recognise you.

No credentials or API keys are needed to test any of this — the endpoints are
open on purpose so you can poke at them. To see a call land in the database:

```bash
curl https://voice-agent-production-087d.up.railway.app/patients
```

`/calls` has the transcript of every call, including ones that ended without a
registration. The dashboard shows both: registered patients on top, and every
call underneath with its duration, how it ended, and an expandable transcript.

## Setup

```bash
npm install
cp .env.example .env
npx prisma migrate deploy
npm run seed        # optional, adds two demo patients
npm run dev
```

That gets the API and dashboard running on port 3000. To create the voice agent
itself:

```bash
npm run provision
```

That script builds the Vapi assistant from `src/vapi/prompt.md` and binds it to
your phone number. It's idempotent — edit the prompt, run it again, and the live
assistant updates in place. There's no clicking around in a dashboard, which
also means the repo is the source of truth for how the agent behaves.

### Environment variables

| Variable | Used by | Notes |
| --- | --- | --- |
| `DATABASE_URL` | server | Postgres connection string |
| `VAPI_SECRET` | server + provision | A secret you make up. Vapi sends it back as `x-vapi-secret` so the webhook can tell it's really Vapi calling. It is not a Vapi API key. |
| `PUBLIC_BASE_URL` | provision | Where Vapi should send tool calls |
| `VAPI_PRIVATE_KEY` | provision | Vapi API key, only needed to create the assistant |
| `VAPI_PHONE_NUMBER` | provision | Which number to attach it to |
| `PORT` | server | Railway sets this itself; don't hardcode it |

In production only the first two matter. The server never calls Vapi — traffic
only goes the other way.

## How it works

Vapi handles the phone line, speech recognition, the LLM and the voice. It does
not decide whether anything the caller says is valid. This service decides that,
and it never decides what to say. Keeping that line clean is most of the design.

When someone calls, Vapi runs the conversation and calls one of three tools on
this server: `lookup_patient` at the start to check for an existing record,
`register_patient` once the caller has confirmed their details, and
`update_patient` if they're already on file. Those tools run the same validation
and hit the same service functions that the REST API does, so a record created
over the phone is exactly as trustworthy as one created with `curl`.

The tools don't return status codes. They return sentences, because whatever
they return goes straight back into the model's context. A validation failure
comes back as "NOT SAVED. These fields are invalid: date_of_birth (cannot be in
the future). Ask the caller only about those fields." A database outage comes
back as an apology to read out. The model is never handed a 422 and asked to
improvise a bedside manner, which is what keeps a failing call from turning into
dead air.

One consequence worth pointing out: Riley can only say "you're all set" after
`register_patient` returns a string starting with `SAVED`. That sentence has no
other source, so he can't promise a registration that didn't happen.

### The code

`src/patients/schema.js` is the interesting file. It's Zod, and it's the only
thing that decides whether a record is acceptable. It's deliberately forgiving
about formatting and strict about content, because everything arrives via speech
— "California" becomes `CA`, "(213) 528-3131" becomes `2135283131`, both
`MM/DD/YYYY` and ISO dates parse, and optional fields answered "none" are stored
as null rather than the literal word. Dates are round-trip checked, so
`02/30/1990` is rejected instead of quietly becoming March 2nd.

`src/patients/service.js` and `src/calls/service.js` are the only modules that
touch Prisma. `src/vapi/tools.js` holds the tool logic, `src/vapi/routes.js` is
just transport and auth, and the REST routes are thin wrappers over the same
services. `scripts/provision.js` is the entire agent configuration — model,
voice, transcriber, tool schemas, webhook URL.

### API

Everything returns `{ "data": ..., "error": ... }`.

| Method | Path | |
| --- | --- | --- |
| GET | `/patients` | filters: `last_name`, `date_of_birth`, `phone_number`, `limit`, `offset` |
| GET | `/patients/:id` | by UUID |
| POST | `/patients` | 201 with the created record |
| PUT | `/patients/:id` | partial; omitted fields are left alone |
| DELETE | `/patients/:id` | soft delete, sets `deleted_at` |
| GET | `/calls` | transcripts, durations, how each call ended |
| GET | `/health` | includes a database check |

A 422 lists the specific fields that failed, which is what lets the agent re-ask
for one thing instead of starting over.

## Choices I made

I used Vapi rather than building the speech pipeline. I've built the harder
version before — LiveKit with a Twilio SIP bridge, Deepgram, and a deterministic
control plane between two LLM calls — and that's a multi-day project on its own.
It's the right architecture when the agent has authority it must not exceed, like
a salary ceiling in a negotiation. Patient intake has no such authority: there's
no number Riley must not say. So one model with tools is the correct shape here,
and anything more would be architecture for its own sake.

Postgres instead of SQLite, because container filesystems don't survive
redeploys and "the data must still be there on the second call" is the whole
point. Prisma because the schema is a deliverable here and one declarative file
gives me the migration and the client. Zod rather than relying on database
constraints, because validation has to happen before the write and has to
produce field-level messages someone can say out loud. Tests use `node:test`
since it ships with Node and this is 24 assertions, not a test pyramid.

The prompt lives in `src/vapi/prompt.md` rather than in a string literal, because
it's a design artifact and deserves to show up in diffs. Two things in it are
worth explaining. First, the required fields are collected before the optional
ones are offered, as a single opt-in question rather than a list — given sixteen
fields flat, the model interrogates people. Second, Riley asks callers to spell
their names and treats the spelling as authoritative over what he heard. That
came out of a test call: the transcriber heard "Saham" as "Sam", and because the
prompt originally said to read the name back, he confidently confirmed his own
mistake. Confirming a mishearing is worse than not confirming. Asking someone to
spell turns "recognise an unfamiliar proper noun" into "recognise 26 known
words", and the saved record came out right on the next call.

Anything that can be expressed as "this data is invalid" is in Zod, not the
prompt. A rule in the prompt is a suggestion the model can ignore; the same rule
in code is a guarantee. So the prompt contains no validation logic at all — only
persona, call flow, how to ask for things, and what to do with each tool result.

## What it doesn't do

Nothing is saved until the caller confirms. If the line drops halfway through,
that call leaves a row in `/calls` with the transcript and nothing else. Saving
incrementally means a partial-record state machine and reconciliation on
callback, and I'd rather spend that hour on the conversation. It's the right call
at this size and the wrong one for anything real.

Duplicate detection works off caller ID, with a fallback: if the number you're
calling from doesn't match anything on file, it checks whether that number has
called before and created a record. That covers the common case of registering a
different contact number than the one you're phoning from. It still won't fire
for someone whose first call was from a different phone.

Spanish is half-supported and I'd rather say so than list it as a feature. The
prompt tells Riley to switch languages and the model and voice will both oblige,
but the transcriber is pinned to English, so Spanish speech transcribes badly.
Deepgram has a multilingual mode; I didn't switch because I couldn't test whether
it hurts English accuracy, and English is what gets graded.

The database is reached over Railway's public TCP proxy rather than its private
network. The private hostname is IPv6-only and wasn't resolving from the app
container. It costs a few milliseconds and I'd fix it properly with more time.

There's no auth on the API, deliberately — the data is fake and the reviewer
should be able to poke at it. It's the first thing that would have to change.
Same for rate limiting. The webhook is protected by a shared secret, which is
adequate here and nowhere near adequate for real patient data.

Calls cost roughly $0.15–0.20 a minute with GPT-4o and Deepgram nova-3.
`maxDurationSeconds` is capped at 300 so a stuck call can't quietly drain the
account overnight.

## Next steps

The thing I'd do first is incremental saving with a draft status, so a dropped
call isn't a wasted one and Riley can pick up where he left off when you ring
back. That's also the most human-feeling feature on the list.

After that: fix Spanish properly and A/B it against the English-only config
before trusting it. Put an API key on the API and move the dashboard off the
public root. Use Deepgram's per-word confidence to decide when to ask for a
spelling — right now every name gets spelled, which is safe but slightly slow,
and a name transcribed at 0.98 confidence doesn't need it. Add appointment
scheduling, which is one more tool and a mock availability table. Put a retry
with backoff around the database write so a transient blip becomes a pause
rather than an apology.

The one that matters most long-term is a proper eval: a set of scripted call
scenarios run against the assistant, asserting on the final saved payload. Right
now "is the conversation any good?" is answered by me listening to it, which
doesn't scale and won't catch a regression when someone edits the prompt.

## Tests

```bash
npm test
```

24 tests against a real database, covering the validation rules, every endpoint,
status codes, soft-delete behaviour, and the full voice path including transcript
linkage. They exercise the same code the phone calls do.
