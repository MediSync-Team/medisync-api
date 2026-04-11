-- CreateEnum
CREATE TYPE "Rol" AS ENUM ('PROFESIONAL', 'PACIENTE');

-- CreateEnum
CREATE TYPE "Modalidad" AS ENUM ('PRESENCIAL', 'VIRTUAL', 'AMBOS');

-- CreateEnum
CREATE TYPE "EstadoTurno" AS ENUM ('RESERVADO', 'CONFIRMADO', 'COMPLETADO', 'CANCELADO', 'AUSENTE');

-- CreateEnum
CREATE TYPE "EstadoPago" AS ENUM ('PENDIENTE', 'APROBADO', 'RECHAZADO', 'REEMBOLSADO');

-- CreateEnum
CREATE TYPE "TipoArchivo" AS ENUM ('EVOLUCION', 'LABORATORIO', 'IMAGEN', 'OTRO');

-- CreateEnum
CREATE TYPE "Genero" AS ENUM ('MASCULINO', 'FEMENINO', 'OTRO', 'NO_ESPECIFICADO');

-- CreateTable
CREATE TABLE "usuario" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "rol" "Rol" NOT NULL DEFAULT 'PACIENTE',
    "google_token" TEXT,
    "mp_access_token" TEXT,
    "mp_refresh_token" TEXT,
    "mp_vendedor_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usuario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "especialidad" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "descripcion" TEXT,
    "icono" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "especialidad_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profesional" (
    "id" TEXT NOT NULL,
    "usuario_id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "apellido" TEXT NOT NULL,
    "telefono" TEXT NOT NULL,
    "genero" "Genero" NOT NULL DEFAULT 'NO_ESPECIFICADO',
    "matricula" TEXT,
    "precio_consulta" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "bio" TEXT,
    "lugar_atencion" TEXT,
    "foto_url" TEXT,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "especialidad_id" TEXT NOT NULL,

    CONSTRAINT "profesional_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disponibilidad" (
    "id" TEXT NOT NULL,
    "professional_id" TEXT NOT NULL,
    "dia_semana" INTEGER NOT NULL,
    "hora_inicio" TEXT NOT NULL,
    "hora_fin" TEXT NOT NULL,
    "modalidad" "Modalidad" NOT NULL DEFAULT 'PRESENCIAL',
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "disponibilidad_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "paciente" (
    "id" TEXT NOT NULL,
    "usuario_id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "apellido" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "telefono" TEXT,
    "genero" "Genero" NOT NULL DEFAULT 'NO_ESPECIFICADO',
    "fecha_nacimiento" TIMESTAMP(3),
    "dni" TEXT,
    "obra_social" TEXT,
    "foto_url" TEXT,
    "acepta_recordatorios" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "paciente_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "turno" (
    "id" TEXT NOT NULL,
    "profesional_id" TEXT NOT NULL,
    "paciente_id" TEXT,
    "fecha_hora" TIMESTAMP(3) NOT NULL,
    "duracion_min" INTEGER NOT NULL DEFAULT 30,
    "modalidad" "Modalidad" NOT NULL,
    "estado" "EstadoTurno" NOT NULL DEFAULT 'RESERVADO',
    "link_videollamada" TEXT,
    "notas_cancelacion" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "turno_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evolucion" (
    "id" TEXT NOT NULL,
    "turno_id" TEXT NOT NULL,
    "contenido" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "evolucion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "archivo" (
    "id" TEXT NOT NULL,
    "turno_id" TEXT NOT NULL,
    "tipo" "TipoArchivo" NOT NULL DEFAULT 'OTRO',
    "url" TEXT NOT NULL,
    "nombre_original" TEXT NOT NULL,
    "tamano_bytes" INTEGER NOT NULL,
    "mime_type" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "archivo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pago" (
    "id" TEXT NOT NULL,
    "turno_id" TEXT NOT NULL,
    "monto" DECIMAL(10,2) NOT NULL,
    "comision_porcentaje" DECIMAL(5,2) NOT NULL DEFAULT 10,
    "monto_neto" DECIMAL(10,2) NOT NULL,
    "estado" "EstadoPago" NOT NULL DEFAULT 'PENDIENTE',
    "mp_preferencia_id" TEXT,
    "mp_payment_id" TEXT,
    "mp_status" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pago_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "usuario_email_key" ON "usuario"("email");

-- CreateIndex
CREATE UNIQUE INDEX "especialidad_nombre_key" ON "especialidad"("nombre");

-- CreateIndex
CREATE UNIQUE INDEX "profesional_usuario_id_key" ON "profesional"("usuario_id");

-- CreateIndex
CREATE INDEX "disponibilidad_professional_id_idx" ON "disponibilidad"("professional_id");

-- CreateIndex
CREATE UNIQUE INDEX "paciente_usuario_id_key" ON "paciente"("usuario_id");

-- CreateIndex
CREATE INDEX "turno_profesional_id_fecha_hora_idx" ON "turno"("profesional_id", "fecha_hora");

-- CreateIndex
CREATE INDEX "turno_paciente_id_idx" ON "turno"("paciente_id");

-- CreateIndex
CREATE INDEX "turno_estado_fecha_hora_idx" ON "turno"("estado", "fecha_hora");

-- CreateIndex
CREATE UNIQUE INDEX "turno_profesional_id_fecha_hora_key" ON "turno"("profesional_id", "fecha_hora");

-- CreateIndex
CREATE UNIQUE INDEX "evolucion_turno_id_key" ON "evolucion"("turno_id");

-- CreateIndex
CREATE INDEX "archivo_turno_id_idx" ON "archivo"("turno_id");

-- CreateIndex
CREATE UNIQUE INDEX "pago_turno_id_key" ON "pago"("turno_id");

-- AddForeignKey
ALTER TABLE "profesional" ADD CONSTRAINT "profesional_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuario"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profesional" ADD CONSTRAINT "profesional_especialidad_id_fkey" FOREIGN KEY ("especialidad_id") REFERENCES "especialidad"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disponibilidad" ADD CONSTRAINT "disponibilidad_professional_id_fkey" FOREIGN KEY ("professional_id") REFERENCES "profesional"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paciente" ADD CONSTRAINT "paciente_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuario"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "turno" ADD CONSTRAINT "turno_profesional_id_fkey" FOREIGN KEY ("profesional_id") REFERENCES "profesional"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "turno" ADD CONSTRAINT "turno_paciente_id_fkey" FOREIGN KEY ("paciente_id") REFERENCES "paciente"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evolucion" ADD CONSTRAINT "evolucion_turno_id_fkey" FOREIGN KEY ("turno_id") REFERENCES "turno"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "archivo" ADD CONSTRAINT "archivo_turno_id_fkey" FOREIGN KEY ("turno_id") REFERENCES "turno"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pago" ADD CONSTRAINT "pago_turno_id_fkey" FOREIGN KEY ("turno_id") REFERENCES "turno"("id") ON DELETE CASCADE ON UPDATE CASCADE;

