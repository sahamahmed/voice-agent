ALTER TABLE "patients" ADD COLUMN "vapi_call_id" TEXT;
CREATE UNIQUE INDEX "patients_vapi_call_id_key" ON "patients"("vapi_call_id");
