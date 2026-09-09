import { app } from "./app.js";
import { prisma } from "./db.js";
import { log } from "./log.js";

const port = process.env.PORT || 3000;

const start = async () => {
  await prisma.$connect();
  app.listen(port, () => log.info("server.started", { port }));
};

const shutdown = async (signal) => {
  log.info("server.stopping", { signal });
  await prisma.$disconnect();
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

start().catch((error) => {
  log.error("server.start_failed", { error: error.message });
  process.exit(1);
});
