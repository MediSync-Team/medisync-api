-- 1) Asegurar valores del enum Rol
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_enum e ON t.oid = e.enumtypid
    WHERE t.typname = 'Rol' AND e.enumlabel = 'CLINICA'
  ) THEN
    ALTER TYPE "Rol" ADD VALUE 'CLINICA';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_enum e ON t.oid = e.enumtypid
    WHERE t.typname = 'Rol' AND e.enumlabel = 'ADMIN'
  ) THEN
    ALTER TYPE "Rol" ADD VALUE 'ADMIN';
  END IF;
END $$;

-- 2) Ajustes en usuario (compatibles con schema actual)
ALTER TABLE "usuario" ALTER COLUMN "password_hash" DROP NOT NULL;

ALTER TABLE "usuario" ADD COLUMN IF NOT EXISTS "provider" TEXT;
ALTER TABLE "usuario" ADD COLUMN IF NOT EXISTS "provider_account_id" TEXT;

ALTER TABLE "usuario" ADD COLUMN IF NOT EXISTS "push_turno" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "usuario" ADD COLUMN IF NOT EXISTS "push_cancelacion" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "usuario" ADD COLUMN IF NOT EXISTS "push_recordatorio" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "usuario" ADD COLUMN IF NOT EXISTS "push_receta" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "usuario" ADD COLUMN IF NOT EXISTS "push_chat" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "usuario" ADD COLUMN IF NOT EXISTS "failed_login_attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "usuario" ADD COLUMN IF NOT EXISTS "locked_until" TIMESTAMP(3);
ALTER TABLE "usuario" ADD COLUMN IF NOT EXISTS "last_failed_login_at" TIMESTAMP(3);

-- 3) Crear tabla clinica
CREATE TABLE IF NOT EXISTS "clinica" (
  "id" TEXT NOT NULL,
  "usuario_id" TEXT NOT NULL,
  "nombre" TEXT NOT NULL,
  "descripcion" TEXT,
  "logo_url" TEXT,
  "direccion" TEXT,
  "telefono" TEXT,
  "website" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "clinica_pkey" PRIMARY KEY ("id")
);

-- 4) Constraints de clinica (idempotentes reales)
DO $$
BEGIN
  -- Si ya existe el índice con ese nombre, no creamos el UNIQUE
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'clinica_usuario_id_key'
  ) THEN
    ALTER TABLE "clinica" ADD CONSTRAINT "clinica_usuario_id_key" UNIQUE ("usuario_id");
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'clinica_usuario_id_fkey'
  ) THEN
    ALTER TABLE "clinica" ADD CONSTRAINT "clinica_usuario_id_fkey"
    FOREIGN KEY ("usuario_id") REFERENCES "usuario"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;