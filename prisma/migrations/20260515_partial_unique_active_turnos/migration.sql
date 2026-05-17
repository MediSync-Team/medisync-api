-- Allow rebooking a time slot after the previous appointment was cancelled.
DROP INDEX IF EXISTS "turno_profesional_id_fecha_hora_key";

CREATE UNIQUE INDEX "turno_profesional_id_fecha_hora_active_key"
  ON "turno"("profesional_id", "fecha_hora")
  WHERE "estado" <> 'CANCELADO';
