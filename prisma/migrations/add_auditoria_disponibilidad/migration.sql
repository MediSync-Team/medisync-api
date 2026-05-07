-- CreateEnum
CREATE TYPE "TipoEventoAuditoria" AS ENUM (
  'DISPONIBILIDAD_CREADA',
  'DISPONIBILIDAD_ELIMINADA',
  'BLOQUEO_CREADO',
  'BLOQUEO_ELIMINADO',
  'TURNO_CANCELADO_POR_BLOQUEO',
  'TURNO_CANCELADO_POR_PROFESIONAL'
);

-- CreateTable
CREATE TABLE "auditoria_disponibilidad" (
  "id" TEXT NOT NULL,
  "profesional_id" TEXT NOT NULL,
  "tipo_evento" "TipoEventoAuditoria" NOT NULL,
  "disponibilidad_id" TEXT,
  "bloqueo_id" TEXT,
  "turno_id" TEXT,
  "detalle" JSONB,
  "creado_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "auditoria_disponibilidad_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "auditoria_disponibilidad_profesional_id_creado_at_idx"
  ON "auditoria_disponibilidad"("profesional_id", "creado_at");

-- CreateIndex
CREATE INDEX "auditoria_disponibilidad_turno_id_idx"
  ON "auditoria_disponibilidad"("turno_id");

-- AddForeignKey
ALTER TABLE "auditoria_disponibilidad"
  ADD CONSTRAINT "auditoria_disponibilidad_profesional_id_fkey"
  FOREIGN KEY ("profesional_id") REFERENCES "profesional"("id") ON DELETE CASCADE ON UPDATE CASCADE;
