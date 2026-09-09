import express from "express";
import { patientsRouter } from "./patients/routes.js";
import { vapiRouter } from "./vapi/routes.js";
import { fail } from "./http.js";
import { log } from "./log.js";
import { prisma } from "./db.js";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.get("/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ data: { status: "ok", database: "connected" }, error: null });
  } catch {
    res.status(503).json({ data: null, error: { message: "Database unreachable" } });
  }
});

app.use("/patients", patientsRouter);
app.use("/vapi", vapiRouter);

app.use((_req, res) => fail(res, 404, "Not found"));

app.use((err, _req, res, _next) => {
  if (err?.type === "entity.parse.failed") return fail(res, 400, "Request body is not valid JSON");
  if (err?.code === "P2002") return fail(res, 409, "A record with those details already exists");
  if (err?.code === "P2025") return fail(res, 404, "Patient not found");
  log.error("unhandled", { message: err?.message, stack: err?.stack });
  return fail(res, 500, "Internal server error");
});

const port = process.env.PORT || 3000;
app.listen(port, () => log.info("server.started", { port }));
