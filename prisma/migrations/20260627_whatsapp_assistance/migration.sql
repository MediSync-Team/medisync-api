ALTER TABLE "turno"
ADD COLUMN IF NOT EXISTS "asistencia_confirmada_at" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "whatsapp_session" (
  "id" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "paciente_id" TEXT,
  "turno_id" TEXT,
  "estado" TEXT NOT NULL,
  "data" JSONB,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "whatsapp_session_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_session_phone_key" ON "whatsapp_session"("phone");
CREATE INDEX IF NOT EXISTS "whatsapp_session_expires_at_idx" ON "whatsapp_session"("expires_at");
