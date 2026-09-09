CREATE TABLE "call_logs" (
    "vapi_call_id" TEXT NOT NULL,
    "caller_number" TEXT,
    "ended_reason" TEXT,
    "duration_seconds" INTEGER,
    "summary" TEXT,
    "transcript" TEXT,
    "patient_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_logs_pkey" PRIMARY KEY ("vapi_call_id")
);

CREATE INDEX "call_logs_created_at_idx" ON "call_logs"("created_at");
