// Every response is { data, error } — one shape, so no caller has to branch.
export const ok = (res, data, status = 200) => res.status(status).json({ data, error: null });

export const fail = (res, status, message, details) =>
  res.status(status).json({ data: null, error: { message, ...(details ? { details } : {}) } });

// Express 4 does not forward rejected promises to the error middleware.
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
