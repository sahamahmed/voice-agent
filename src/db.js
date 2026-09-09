import { PrismaClient } from "@prisma/client";

// One client per process. Prisma pools internally; a client per request is the
// classic way to exhaust a small Postgres plan.
export const prisma = new PrismaClient({ log: ["warn", "error"] });
