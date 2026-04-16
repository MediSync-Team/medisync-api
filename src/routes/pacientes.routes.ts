import { Router } from 'express';
import prisma from '../lib/prisma';
import { asyncHandler, success, AppError } from '../utils/response';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';

const router = Router();

const CLINICAL_HISTORY_FIELDS = [
  'antecedentesPersonales',
  'antecedentesFamiliares',
  'alergias',
  'medicacionActual',
  'habitos',
  'diagnosticosPrevios',
  'notasClinicasGenerales',
] as const;

type ClinicalHistoryField = typeof CLINICAL_HISTORY_FIELDS[number];

async function assertProfessionalPatientAccess(userId: string, pacienteId: string) {
  const profesional = await prisma.profesional.findUnique({
    where: { usuarioId: userId },
  });

  if (!profesional) {
    throw new AppError(404, 'NOT_FOUND', 'Profesional no encontrado');
  }

  const paciente = await prisma.paciente.findUnique({
    where: { id: pacienteId },
  });

  if (!paciente) {
    throw new AppError(404, 'NOT_FOUND', 'Paciente no encontrado');
  }

  const hasRelationship = await prisma.turno.findFirst({
    where: {
      profesionalId: profesional.id,
      pacienteId,
    },
    select: { id: true },
  });

  if (!hasRelationship) {
    throw new AppError(403, 'FORBIDDEN', 'Sin permisos para acceder a este paciente');
  }

  return { profesional, paciente };
}

router.put('/perfil', authMiddleware('PACIENTE'), asyncHandler(async (req: AuthRequest, res) => {
  const { nombre, apellido, telefono, genero, fechaNacimiento, dni, obraSocial, fotoUrl } = req.body;

  if (telefono && !/^[\d\s\-\+\(\)]{8,20}$/.test(telefono)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'El teléfono tiene un formato inválido');
  }

  if (dni && !/^\d{7,8}$/.test(dni)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'El DNI debe tener entre 7 y 8 dígitos numéricos');
  }

  if (genero && !['MASCULINO', 'FEMENINO', 'OTRO', 'NO_ESPECIFICADO'].includes(genero)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'El género debe ser MASCULINO, FEMENINO, OTRO o NO_ESPECIFICADO');
  }

  const paciente = await prisma.paciente.findUnique({
    where: { usuarioId: req.user!.userId },
  });

  if (!paciente) {
    throw new AppError(404, 'NOT_FOUND', 'Paciente no encontrado');
  }

  const updated = await prisma.paciente.update({
    where: { id: paciente.id },
    data: {
      nombre,
      apellido,
      telefono: telefono || null,
      genero: genero || 'NO_ESPECIFICADO',
      fechaNacimiento: fechaNacimiento ? new Date(fechaNacimiento) : null,
      dni: dni || null,
      obraSocial: obraSocial || null,
      fotoUrl: fotoUrl || null,
    },
  });

  res.json(success(updated));
}));

router.get('/perfil', authMiddleware('PACIENTE'), asyncHandler(async (req: AuthRequest, res) => {
  const paciente = await prisma.paciente.findUnique({
    where: { usuarioId: req.user!.userId },
  });

  if (!paciente) {
    throw new AppError(404, 'NOT_FOUND', 'Paciente no encontrado');
  }

  res.json(success(paciente));
}));

router.get('/:id/historia-clinica', authMiddleware('PROFESIONAL'), asyncHandler(async (req: AuthRequest, res) => {
  const { id: pacienteId } = req.params;
  const { profesional, paciente } = await assertProfessionalPatientAccess(req.user!.userId, pacienteId);

  const turnos = await prisma.turno.findMany({
    where: {
      pacienteId,
      profesionalId: profesional.id,
    },
    include: {
      evolucion: true,
      archivos: {
        orderBy: { createdAt: 'desc' },
      },
      profesional: {
        include: {
          especialidad: true,
        },
      },
    },
    orderBy: { fechaHora: 'desc' },
  });

  const timeline = turnos.map((turno) => ({
    id: turno.id,
    fechaHora: turno.fechaHora,
    modalidad: turno.modalidad,
    estado: turno.estado,
    profesional: {
      id: turno.profesional.id,
      nombre: turno.profesional.nombre,
      apellido: turno.profesional.apellido,
      especialidad: turno.profesional.especialidad.nombre,
    },
    evolucion: turno.evolucion
      ? {
          id: turno.evolucion.id,
          contenido: turno.evolucion.contenido,
          updatedAt: turno.evolucion.updatedAt,
        }
      : null,
    archivos: turno.archivos.map((archivo) => ({
      id: archivo.id,
      tipo: archivo.tipo,
      nombreOriginal: archivo.nombreOriginal,
      url: archivo.url,
      createdAt: archivo.createdAt,
    })),
  }));

  const turnosCompletados = turnos.filter((turno) => turno.estado === 'COMPLETADO').length;

  res.json(success({
    paciente: {
      id: paciente.id,
      nombre: paciente.nombre,
      apellido: paciente.apellido,
      email: paciente.email,
      telefono: paciente.telefono,
      genero: paciente.genero,
      fechaNacimiento: paciente.fechaNacimiento,
      dni: paciente.dni,
      obraSocial: paciente.obraSocial,
      antecedentesPersonales: paciente.antecedentesPersonales,
      antecedentesFamiliares: paciente.antecedentesFamiliares,
      alergias: paciente.alergias,
      medicacionActual: paciente.medicacionActual,
      habitos: paciente.habitos,
      diagnosticosPrevios: paciente.diagnosticosPrevios,
      notasClinicasGenerales: paciente.notasClinicasGenerales,
    },
    resumen: {
      totalConsultas: turnos.length,
      consultasCompletadas: turnosCompletados,
      ultimaConsulta: turnos[0]?.fechaHora || null,
    },
    timeline,
  }));
}));

router.put('/:id/historia-clinica', authMiddleware('PROFESIONAL'), asyncHandler(async (req: AuthRequest, res) => {
  const { id: pacienteId } = req.params;
  await assertProfessionalPatientAccess(req.user!.userId, pacienteId);

  const payload = req.body as Partial<Record<ClinicalHistoryField, unknown>>;
  const updateData: Partial<Record<ClinicalHistoryField, string | null>> = {};

  for (const field of CLINICAL_HISTORY_FIELDS) {
    if (!(field in payload)) continue;

    const value = payload[field];

    if (value === null || value === undefined) {
      updateData[field] = null;
      continue;
    }

    if (typeof value !== 'string') {
      throw new AppError(400, 'VALIDATION_ERROR', `El campo ${field} debe ser texto`);
    }

    if (value.length > 4000) {
      throw new AppError(400, 'VALIDATION_ERROR', `El campo ${field} supera el maximo permitido`);
    }

    const trimmed = value.trim();
    updateData[field] = trimmed.length > 0 ? trimmed : null;
  }

  if (Object.keys(updateData).length === 0) {
    throw new AppError(400, 'VALIDATION_ERROR', 'No se recibieron campos validos para actualizar');
  }

  const updated = await prisma.paciente.update({
    where: { id: pacienteId },
    data: updateData,
    select: {
      id: true,
      antecedentesPersonales: true,
      antecedentesFamiliares: true,
      alergias: true,
      medicacionActual: true,
      habitos: true,
      diagnosticosPrevios: true,
      notasClinicasGenerales: true,
      updatedAt: true,
    },
  });

  res.json(success(updated));
}));

export { router as pacientesRouter };
