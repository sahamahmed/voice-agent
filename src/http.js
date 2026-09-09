export const ok = (res, data, status = 200) => res.status(status).json({ data, error: null });

export const fail = (res, status, message, details) =>
  res.status(status).json({ data: null, error: { message, ...(details ? { details } : {}) } });

export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
