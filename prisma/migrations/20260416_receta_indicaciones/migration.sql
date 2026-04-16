CREATE TABLE "receta_indicacion" (
    "id" TEXT NOT NULL,
    "turno_id" TEXT NOT NULL,
    "diagnostico" TEXT NOT NULL,
    "plan_tratamiento" TEXT,
    "medicamentos" TEXT,
    "indicaciones" TEXT NOT NULL,
    "estudios_solicitados" TEXT,
    "proximo_control" TEXT,
    "advertencias" TEXT,
    "observaciones" TEXT,
    "emitida_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "receta_indicacion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "receta_indicacion_turno_id_key" ON "receta_indicacion"("turno_id");

ALTER TABLE "receta_indicacion" ADD CONSTRAINT "receta_indicacion_turno_id_fkey"
FOREIGN KEY ("turno_id") REFERENCES "turno"("id") ON DELETE CASCADE ON UPDATE CASCADE;
