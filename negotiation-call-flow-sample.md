# Negotiation Call — End-to-End Flow (with Twilio)

This is the operational flow doc: what actually happens, in order, from HR
clicking "Start Offer Call" to the candidate's outcome landing back on the
dashboard — including exactly where Twilio sits in the path. For the
control-plane conversation architecture (how the agent decides what to say),
see `docs/negotiation.md`. For how to run/debug the worker locally, see
`docs/negotiation-agent-guide.md`. This doc sits above both: it's the
lifecycle, not the internals of one call turn.

## Actors and repo boundaries

| Piece | Location | Role |
|---|---|---|
| HR-facing orchestration, mandate freezing, Twilio/SIP dialing | `apps/core/src/negotiation/` | Owns the call row, the phone call, the outcome |
| Tenant negotiation policy defaults | `apps/core/src/negotiation-policy/` | Company-wide stance/benefits/notice rules, must be configured before any call |
| The LiveKit voice worker | `services/negotiation-agent/` | Conducts the actual conversation |
| Shared mandate/report contracts | `libs/common/src/interface/negotiation.interface.ts` | The frozen contract both sides read/write |
| Frontend trigger | `applicant-details-page-client.tsx` (applicant details page) | "Start Offer Call" button, offer settings gate, dev test-harness dialog |
| Frontend cross-job view | `negotiations-dashboard-client.tsx` | Hold-review / ready-for-offer / offer / needs-interviewer buckets |

## Prerequisites (gates checked before anything is dialed)

1. **Tenant negotiation policy configured** — `NegotiationPolicyService.getOrCreate()` upserts a defaulted policy on first read, but `configured` is only ever set by an explicit HR save. `startCall()` rejects with 400 if not configured.
2. **Job has `offerParams`** — salary band (min/target/max), allowances, non-negotiables, notice-buyout budget, `offerAutomation` (what to do on accept/decline). Rejected with 400 if absent.
3. **Candidate is in an eligible status** — `PROCESS_COMPLETED` (first call) or `OFFER_HOLD` (a prior call ended needing human review). Enforced backend-side even though the frontend also gates the button.
4. **No other call already in flight** — a concurrency guard rejects a second start while an existing call for the same candidate is in any non-terminal status (`pending`/`dialing`/`ringing`/`in_progress`).

## How the voice agent works — the LiveKit architecture

This is the generic infrastructure picture — how LiveKit, the worker process,
and the speech providers fit together — independent of any negotiation-specific
business logic (that part is in `docs/negotiation.md`).

### The building blocks

- **Room** — LiveKit's unit of a call. One room per negotiation call; the room
  name *is* the `sessionId`, so a token or dispatch scoped to one room can
  never reach another call.
- **Participants** — two sides join the same room: the candidate (either a
  real phone caller bridged in over SIP, or a browser in the dev test
  harness — see the Twilio section below) and the agent itself, which joins
  as its own bot participant.
- **Worker process** — `services/negotiation-agent` is a long-lived Node
  process, not a per-call script. It registers with LiveKit once
  (`cli.runApp(new WorkerOptions({ agentName: 'negotiation-agent', ... }))`)
  and then sits idle until LiveKit dispatches it a job (= a room to join).
- **Explicit dispatch** — LiveKit's *automatic* dispatch would hand any
  unnamed room to any unnamed worker in the project. `services/interview-voice-engine`
  shares this same LiveKit project and also runs a worker, and automatic
  dispatch has actually misrouted negotiation rooms to the interview worker in
  practice (it joins, finds no matching session, and silently disconnects
  within a second). The fix is naming both sides: the worker registers as
  `agentName: 'negotiation-agent'`, and every room-creation path — the SIP
  path's `RoomServiceClient.createRoom({ agents: [...] })` and the browser
  path's `AccessToken.roomConfig` — explicitly requests that exact agent name.
- **Prewarm** — the worker loads heavy, call-independent state once when the
  *process* starts (the Silero VAD model, pre-rendered filler audio clips),
  not once per call. This moves several seconds of cold start off the actual
  ringing-to-greeting path. `numIdleProcesses: 1` keeps one process warm even
  in dev so the first test call of a session isn't the one paying that cost.

### The per-turn pipeline (`voice.AgentSession`)

Inside one call, LiveKit's agents SDK (`@livekit/agents`) provides
`voice.AgentSession` — the actual turn-taking state machine wired up in
`agent.ts`. It composes four independently swappable legs, each chosen by env
var (`providers.ts`) so switching providers is a deploy-time config change,
never a code edit:

| Leg | Default provider | Notes |
|---|---|---|
| VAD (voice activity detection) | Silero | Decides when the candidate is/isn't speaking; loaded once at prewarm |
| STT (speech-to-text) | Deepgram `nova-3`, streaming | Biased toward call-relevant keyterms ("salary", "notice period", "lakh"...) so a misheard figure is less likely; OpenAI/Groq Whisper exists as a batch fallback but is flagged as worse — it hallucinated short phrases on silence and once ended a live call |
| LLM | OpenAI `gpt-4o-mini` | Two bounded calls per turn (interpret, then speak) rather than one continuous chat — see `docs/negotiation.md` for why |
| TTS (text-to-speech) | Deepgram Aura-2, streaming | ElevenLabs `eleven_v3` is used instead for Urdu (the only TTS option here with Urdu voices at all), wrapped in a sentence-tokenizing adapter because that model doesn't support the plugin's normal streaming path |

The single most important property of any TTS choice here is **whether it
streams**. A non-streaming plugin buffers the entire reply before emitting
one sample of audio — a seven-second reply is seven seconds of dead air no
matter how fast the provider's servers are. This is a client-side property,
not something a faster provider fixes, which is why streaming (Deepgram) is
the default and non-streaming options (OpenAI TTS, self-hosted Kokoro) are
called out as a latency tradeoff rather than a free swap.

`AgentSession` also owns turn-taking mechanics directly: adaptive/ML-based
interruption detection (so a genuine "wait—" can barge in, while a stray mic
click can't), and endpointing (how long to wait after the candidate stops
talking before treating the turn as actually finished).

### What happens on one turn, end to end

```
candidate audio (over SIP/Twilio or the browser)
   → VAD + endpointing decide the turn has ended
   → STT produces a transcript
   → LLM #1 (interpreter, tool-call only) turns it into structured signals
   → [deterministic business logic decides what may be said — docs/negotiation.md]
   → LLM #2 (speaker) composes natural recruiter speech from that decision
   → TTS streams audio back
   → published as the agent's outbound LiveKit audio track
   → heard by the candidate
```

A separate, independent LiveKit audio track carries short pre-rendered
"filler" clips (e.g. "Just a moment...") so the candidate isn't sitting in
silence while the LLM/TTS round trip is in flight — it plays concurrently on
its own track rather than delaying or replacing the real reply.

### Where Twilio fits into this picture

LiveKit is the layer that runs the actual conversation (WebRTC media,
providers, turn logic, above). Twilio never touches any of that — it is only
the **telephony bridge**: the thing that gets a real phone number's audio in
and out of a LiveKit room over SIP. See "Twilio integration reference" below
for exactly how that leg is placed and how it shows up as just another
room participant once connected.

### This pattern isn't negotiation-specific

The whole shape here — a long-lived worker process, explicit name-based
dispatch, `AgentSession` composing swappable VAD/STT/LLM/TTS legs — is a
general pattern, not something built one-off for negotiation calls.
`services/interview-voice-engine` is a second, independent LiveKit worker
built the same way for AI interviews. They share only the LiveKit project's
credentials (hence the explicit-dispatch requirement above) — no other code.

## Step-by-step: start to end

### 1. HR clicks "Start Offer Call"
Frontend calls `POST /negotiation/call/:feedbackId` (`NegotiationController.start`), optionally passing HR overrides (`openingOffer`, `ceiling`, `language: 'en' | 'ur'`). If the tenant hasn't acknowledged offer automation settings yet, an Offer Settings modal blocks first and the call fires automatically once that save succeeds.

### 2. Mandate resolution (the frozen authority snapshot)
`NegotiationService.startCall()` resolves one `NegotiationMandate` via `resolveMandate()` (`mandate-resolver.ts`), applying a strict override order:

```
HR override at click time  >  per-job offerParams  >  tenant policy  >  hard default
```

Key invariant: **the ceiling can only move down.** `ceiling = min(hrOverride.ceiling ?? offerParams.salaryMax, offerParams.salaryMax)` — nobody, including the person clicking the button, can raise the job's outer band. The opening offer is clamped to that ceiling too, so a config typo can't push an over-ceiling opener live.

This mandate is written **once** onto a new `negotiation_calls` Mongo row (status `PENDING`, a random 24-byte hex `sessionId`) and never re-read from live config again — editing the job's band mid-call cannot change what the agent is allowed to offer on a call already in progress.

### 3. The Twilio / SIP branch decision
This is the fork in the road, controlled by `NEGOTIATION_USE_TWILIO_CALL`:

- **`true` (real phone call, production path)** — validate the candidate has a parseable phone number (`libphonenumber-js`, falling back to `NEGOTIATION_SIP_DEFAULT_COUNTRY` for ambiguous local-format numbers), require `LIVEKIT_SIP_OUTBOUND_TRUNK_ID` to be set, then dial (see §4 below).
- **`false` (dev / test-harness path, default)** — mint a LiveKit `AccessToken` for identity `candidate` and return `{ token, serverUrl, roomName }`. The frontend shows these in a copyable dialog for the browser test harness (`services/negotiation-agent/test-page/`). This dialog is explicitly a stopgap — the code comment on it says "Once SIP lands, core places the call and this dialog goes away entirely."

Both branches flip the candidate's `applicantStatus` to `OFFER` on success and create the same kind of `negotiation_calls` row — everything downstream (the worker, the outcome posting, the dashboard) is identical from this point on regardless of which branch started the call.

### 4. Placing the real call — how Twilio actually fits in
Twilio is **not called directly** by this codebase. It sits behind a LiveKit SIP outbound trunk:

```
apps/core (NegotiationService.dialCandidate)
      │  RoomServiceClient.createRoom({ agents: [{ agentName: 'negotiation-agent' }] })
      │  SipClient.createSipParticipant(sipTrunkId, e164Number, roomName, { participantIdentity: 'candidate', playDialtone: true })
      ▼
LiveKit SIP outbound trunk  ──►  Twilio SIP trunk  ──►  PSTN  ──►  candidate's phone
```

- The **LiveKit SIP outbound trunk** (`LIVEKIT_SIP_OUTBOUND_TRUNK_ID`) is registered once against a Twilio (or other) SIP trunk via LiveKit's `lk sip outbound create` CLI — a one-time infra setup step, not something this app's code does at runtime.
- `createRoom` explicitly attaches the `negotiation-agent` dispatch **at room creation**, because a SIP participant has no `AccessToken`/JWT to carry a `roomConfig` the way the browser-token path (`mintToken`) does — this is the SIP-path equivalent of that same explicit-dispatch guarantee.
- `createSipParticipant` places the actual outbound PSTN leg — this is the literal moment Twilio's network rings the candidate's phone.
- On success, the call row moves `PENDING → DIALING`, guarded so it only overwrites `PENDING` — the negotiation-agent worker can connect and call `getMandate()` (which advances the row to `IN_PROGRESS`) faster than this write lands, and the guard stops that race from silently downgrading an already-in-progress call back to `DIALING`.
- On failure (bad trunk config, Twilio rejects the call, etc.), the row is marked `FAILED` with a summary, and the controller returns a 400 telling HR to check the SIP trunk configuration.
- Once the candidate's phone answers, they join the LiveKit room as a normal participant identified `'candidate'` — indistinguishable, from that point on, from the browser test-harness path.

### 5. The negotiation-agent worker picks up the room
The worker registers with an **empty/named `agentName: 'negotiation-agent'`** and explicit dispatch only — this matters because `services/interview-voice-engine` shares the same LiveKit project and also runs a worker; without naming both sides explicitly, LiveKit's automatic dispatch has actually sent negotiation rooms to the interview worker, which finds no matching session and silently disconnects within a second.

The worker:
1. Reads the room name as the `sessionId`.
2. Calls `GET /internal/negotiation/mandate/:sessionId` (shared-secret authenticated via `x-negotiation-secret`, matched against `NEGOTIATION_SHARED_SECRET`) — **fail-closed**: no mandate means no ceiling, and an unbounded agent must never go live. This fetch also flips the call row to `IN_PROGRESS`.
3. Waits for the candidate to actually be present in the room (not just dialed) before speaking, so the greeting isn't wasted on an empty room.
4. Speaks first (it's an outbound call) — a deterministic greeting plus the recording-consent script, in the mandate's chosen language (`en`/`ur`), with interruptions disabled for that one line specifically (a stray STT noise blip once truncated a legally load-bearing consent request mid-sentence).

### 6. The call itself — control-plane loop, per candidate turn
Full architecture is in `docs/negotiation.md`; the short version: **the LLM never decides anything about the deal.** Each candidate turn goes through:

```
① Interpreter (tool-call only)        → structured signals: salary, terms, questions, callIntent
② Deterministic controller             → the ONLY code allowed to change call state; decides
   (turn-resolver + salary-strategy +    concession, agenda, escalation, outcome
    term-turn-handler + call-policy)
③ Grounding                            → one fact universe for both speaker and gate
④ Speaker (tool-free)                  → natural recruiter speech, licensed only to use grounded facts
⑤ Pre-speech gate                      → rejects only a NEW commitment (new number, invented policy,
                                          premature goodbye); restating a known fact always passes
⑥ Verified delivery                    → confirms TTS actually produced audio, re-speaks once if not
```

If the speaker fails, times out, or its draft fails the gate, the controller's own plain wording is spoken instead — the call never goes silent or improvises past its authority.

Salary invariants worth knowing operationally: no approved amount ever exceeds the frozen ceiling; the ceiling itself is never in the prompt or in a rejection explanation; spoken offers are monotonic; an agreed salary must be a spoken offer the candidate explicitly accepted.

### 7. Ending the call
A terminal directive (accepted / declined / counter_pending_hr / callback_requested / needs_hr_review / not_reached) enters `completeCallClosure()` (`call-closure.ts`):

1. Wait for whatever reply is currently in flight to finish (bounded, 5s default).
2. Speak one recap of everything actually agreed (`buildAgreementRecap` — salary, joining date/delay, notice period, other agreed items — nothing not on the ledger), immediately followed by a fixed closing line for that outcome, in the mandate's language. No timeout is applied to this farewell — it drains to actual LiveKit playout completion, not a fixed cutoff, so a longer closing line can't be cut off mid-sentence.
3. Post the outcome exactly once (see §8).
4. Disconnect the room. A candidate's phone/SIP leg hanging up around the same moment is treated as expected, not an error.

A call can also end without a clean model-driven closure: `MAX_CALL_SECONDS` (default 420s) hard-stops with a fixed "wrap up" line, or the candidate's SIP/browser leg simply disconnects (busy, no-answer, SIP trunk failure, or a genuine hang-up mid-call) — each of these is captured via `LiveKit`'s `ParticipantDisconnected` reason and reported as a specific status (`busy` / `no_answer` / `failed` / `abandoned`) rather than a generic failure.

### 8. Outcome posted back to core
`POST /internal/negotiation/outcome` (same shared-secret auth), **fail-open-but-loud** — by the time this fires the call is already over, so throwing achieves nothing a loud log doesn't; a silently lost outcome would just mean HR believes the call never happened.

`NegotiationService.recordOutcome()`:
- Only updates a row that is still `IN_PROGRESS` (guards against a duplicate/late report overwriting an already-recorded outcome).
- Maps the outcome to the candidate's next `ApplicantJobStatus`:
  - Call didn't complete cleanly (no_answer/busy/failed/abandoned) → always `OFFER_HOLD` (human decides whether to retry).
  - `ACCEPTED` → `ACCEPT` if the job's `offerAutomation.onAccepted === AUTO_ACCEPT`, else `OFFER_HOLD`.
  - `DECLINED` → `REJECT` if `offerAutomation.onDeclined === AUTO_REJECT`, else `OFFER_HOLD`.
  - Everything else (`counter_pending_hr` / `callback_requested` / `needs_hr_review`) → always `OFFER_HOLD` (no automation config is consulted for these).

### 9. Back on the dashboard
- Per-candidate call history: `GET /negotiation/call/:feedbackId` — every attempt for that candidate, newest first.
- Cross-job tracking dashboard: `GET /negotiation/dashboard` — four buckets per tenant: `holdReview` (needs a human decision), `readyForOffer` (pipeline done, no call started yet), `offer` (a call has been placed, latest status/outcome joined live), `needsInterviewer` (a different bucket entirely — candidates stuck at an unassigned interview stage).

## Twilio integration reference

| Env var | Meaning |
|---|---|
| `NEGOTIATION_USE_TWILIO_CALL` | Explicit on/off switch for real dialing. Defaults to `false`/harness — a missing or blank value can never accidentally start placing real phone calls. Lets ops flip back to the browser test harness without touching the trunk config. |
| `LIVEKIT_SIP_OUTBOUND_TRUNK_ID` | The LiveKit SIP outbound trunk ID, registered once via `lk sip outbound create` against the Twilio SIP trunk. Required whenever `NEGOTIATION_USE_TWILIO_CALL=true`. |
| `NEGOTIATION_SIP_DEFAULT_COUNTRY` | Fallback region (default `PK`) for parsing a candidate's phone number that has no explicit country code. Never overrides a number that already carries one. |
| `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | LiveKit project credentials — shared with `services/interview-voice-engine`; the explicit `agentName` dispatch (§5) is what keeps the two workers from colliding. |
| `NEGOTIATION_SHARED_SECRET` | Authenticates the two internal endpoints between core and the worker; must match on both sides. |

**Known operational issue (not yet fixed):** a live test call surfaced a Twilio `486 Busy Here` — an unfamiliar US `+1` caller ID cold-calling a Pakistani candidate about their job offer is likely to be rejected or ignored outright. The agreed (but **not yet built**) fix is documented in `docs/superpowers/plans/2026-08-29-negotiation-call-scheduling.md` ("planned, not started" as of that date):

- Send the candidate a heads-up email the moment HR clicks Start, then delay the actual dial by a fixed lead time (30 minutes) so they've had a real chance to see it first (a delayed BullMQ job, reusing the existing `BaseQueueService`/`BaseWorkerService` pattern).
- A new `SCHEDULED` call status between `PENDING` and `DIALING`.
- A work-hours guard (9am–6pm, Mon–Fri, candidate's own IANA timezone) that **blocks and explains** rather than silently rescheduling — checked against `now + lead time`, not just `now`, and enforced on both frontend and backend.
- A "Cancel scheduled call" action for a call that's queued but hasn't dialed yet.

Until that lands, every real Twilio call dials immediately and unannounced the moment HR clicks "Start Offer Call."

## Status and outcome reference

`NegotiationCallStatus` (the call's technical lifecycle):
`pending → dialing → ringing → in_progress → completed` (or terminal `no_answer` / `busy` / `failed` / `abandoned`).

`NegotiationOutcome` (what happened to the *negotiation itself* — independent of call status; a technically `completed` call can still need human review):
`accepted` · `declined` · `counter_pending_hr` · `callback_requested` · `needs_hr_review` · `not_reached`.

## Key files

| File | Owns |
|---|---|
| `apps/core/src/negotiation/negotiation.service.ts` | `startCall`, Twilio/SIP dialing, mandate freezing, outcome recording, dashboard aggregation |
| `apps/core/src/negotiation/negotiation.controller.ts` | HR-facing endpoints (`start`, `list`, `dashboard`) |
| `apps/core/src/negotiation/negotiation-internal.controller.ts` | Shared-secret-authenticated endpoints the worker calls (`mandate`, `outcome`) |
| `apps/core/src/negotiation/mandate-resolver.ts` | Pure three-layer override resolution into one frozen `NegotiationMandate` |
| `libs/common/src/config/app.config.ts` (`livekit`, `negotiation` blocks) | All Twilio/SIP/LiveKit env wiring |
| `services/negotiation-agent/src/agent.ts` | The LiveKit session lifecycle: consent, greeting, per-turn wiring, closure |
| `services/negotiation-agent/src/session-client.ts` | Fail-closed mandate fetch |
| `services/negotiation-agent/src/outcome-client.ts` | Fail-open-but-loud outcome post |
| `services/negotiation-agent/src/call-closure.ts` | Recap + fixed closing line + drained disconnect |
| `docs/negotiation.md` | Control-plane conversation architecture, salary invariants, deal-making |
| `docs/negotiation-agent-guide.md` | How to run/debug the worker locally, log tag reference |
| `docs/superpowers/plans/2026-08-29-negotiation-call-scheduling.md` | The not-yet-built pre-call notice + work-hours guard |
