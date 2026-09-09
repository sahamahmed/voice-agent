import { Router } from "express";
import { ok, fail, wrap } from "../http.js";
import * as service from "./service.js";

export const callsRouter = Router();

callsRouter.get(
  "/",
  wrap(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    if (!Number.isFinite(limit) || limit < 1) return fail(res, 400, "limit must be a positive number");

    const calls = await service.listCalls(limit);
    return ok(res, { calls: calls.map(service.toApi), total: calls.length });
  }),
);
