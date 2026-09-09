// Structured JSON to stdout — Railway captures it, so this is the whole
// observability story without a logging dependency.
const emit = (level, event, data = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, event, ...data }));

export const log = {
  info: (event, data) => emit("info", event, data),
  warn: (event, data) => emit("warn", event, data),
  error: (event, data) => emit("error", event, data),
};
