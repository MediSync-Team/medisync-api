-- CreateEnum
CREATE TYPE "EstadoListaEspera" AS ENUM ('ACTIVA', 'NOTIFICADA', 'RESUELTA', 'CANCELADA');

-- CreateTable
CREATE TABLE "lista_espera" (
    "id" TEXT NOT NULL,
    "profesional_id" TEXT NOT NULL,
    "paciente_id" TEXT NOT NULL,
    "fecha" DATE NOT NULL,
    "modalidad" "Modalidad" NOT NULL,
    "estado" "EstadoListaEspera" NOT NULL DEFAULT 'ACTIVA',
    "notificado_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lista_espera_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lista_espera_profesional_id_fecha_estado_idx" ON "lista_espera"("profesional_id", "fecha", "estado");

-- CreateIndex
CREATE INDEX "lista_espera_paciente_id_estado_idx" ON "lista_espera"("paciente_id", "estado");

-- CreateIndex
CREATE UNIQUE INDEX "lista_espera_profesional_id_paciente_id_fecha_modalidad_estado_key" ON "lista_espera"("profesional_id", "paciente_id", "fecha", "modalidad", "estado");

-- AddForeignKey
ALTER TABLE "lista_espera" ADD CONSTRAINT "lista_espera_profesional_id_fkey" FOREIGN KEY ("profesional_id") REFERENCES "profesional"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lista_espera" ADD CONSTRAINT "lista_espera_paciente_id_fkey" FOREIGN KEY ("paciente_id") REFERENCES "paciente"("id") ON DELETE CASCADE ON UPDATE CASCADE;
