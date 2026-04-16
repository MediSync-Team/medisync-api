-- CreateEnum
CREATE TYPE "NivelRiesgoPreconsulta" AS ENUM ('BAJO', 'MEDIO', 'ALTO', 'URGENTE');

-- AlterTable
ALTER TABLE "turno"
ADD COLUMN "preconsulta_motivo" TEXT,
ADD COLUMN "preconsulta_sintomas" TEXT,
ADD COLUMN "preconsulta_escala_dolor" INTEGER,
ADD COLUMN "preconsulta_escala_ansiedad" INTEGER,
ADD COLUMN "preconsulta_inicio_sintomas" TEXT,
ADD COLUMN "preconsulta_temperatura" DECIMAL(4,1),
ADD COLUMN "preconsulta_notas_paciente" TEXT,
ADD COLUMN "preconsulta_riesgo" "NivelRiesgoPreconsulta",
ADD COLUMN "preconsulta_flags" JSONB,
ADD COLUMN "preconsulta_resumen" TEXT,
ADD COLUMN "preconsulta_completada_at" TIMESTAMP(3);
