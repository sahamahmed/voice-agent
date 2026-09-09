import { Router } from "express";
import * as patients from "../patients/service.js";
import * as calls from "../calls/service.js";
import { toolHandlers, UNAVAILABLE } from "./tools.js";
import { log } from "../log.js";

export const vapiRouter = Router();

const authorised = (req) => {
  const expected = process.env.VAPI_SECRET;
  if (!expected) return true;
  return req.get("x-vapi-secret") === expected;
};

const runToolCall = async (call, callId) => {
  const name = call.name ?? call.function?.name;
  const raw = call.arguments ?? call.function?.arguments ?? {};
  const args = typeof raw === "string" ? JSON.parse(raw) : raw;

  log.info("tool.called", { call_id: callId, name, args });

  const handler = toolHandlers[name];
  if (!handler) return { toolCallId: call.id, result: `Unknown tool "${name}".` };

  try {
    return { toolCallId: call.id, result: await handler(args, { callId }) };
  } catch (error) {
    log.error("tool.failed", { call_id: callId, name, error: error.message });
    return { toolCallId: call.id, result: UNAVAILABLE };
  }
};

const onEndOfCall = async (message) => {
  const callId = message.call?.id;
  if (!callId) return;

  const transcript = message.transcript ?? message.artifact?.transcript ?? null;
  const durationSecs = Math.round(message.durationSeconds ?? 0) || null;

  log.info("call.ended", {
    call_id: callId,
    reason: message.endedReason,
    duration_seconds: durationSecs,
    transcript,
  });

  await calls.recordCall({
    vapiCallId: callId,
    callerNumber: message.call?.customer?.number ?? null,
    endedReason: message.endedReason ?? null,
    durationSecs,
    summary: message.summary ?? message.analysis?.summary ?? null,
    transcript,
  });

  if (transcript) await patients.attachTranscript(callId, transcript);
};

vapiRouter.post("/webhook", async (req, res) => {
  if (!authorised(req)) return res.status(401).json({ data: null, error: { message: "Unauthorized" } });

  const message = req.body?.message ?? {};
  const callId = message.call?.id;

  try {
    if (message.type === "end-of-call-report") {
      await onEndOfCall(message);
      return res.json({ received: true });
    }

    if (message.type !== "tool-calls") return res.json({ received: true });

    const toolCalls = message.toolCallList ?? message.toolCalls ?? [];
    const results = await Promise.all(toolCalls.map((call) => runToolCall(call, callId)));
    return res.json({ results });
  } catch (error) {
    log.error("webhook.failed", { call_id: callId, type: message.type, error: error.message });
    return res.json({
      results: [{ toolCallId: message.toolCallList?.[0]?.id, result: UNAVAILABLE }],
    });
  }
});
