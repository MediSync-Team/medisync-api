-- CreateEnum
CREATE TYPE "PlanProfesional" AS ENUM ('FREE', 'PRO');

-- AlterTable
ALTER TABLE "profesional" ADD COLUMN "plan" "PlanProfesional" NOT NULL DEFAULT 'FREE',
ADD COLUMN "mp_suscripcion_id" TEXT,
ADD COLUMN "plan_vence_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "pago" ALTER COLUMN "comision_porcentaje" SET DEFAULT 0;
