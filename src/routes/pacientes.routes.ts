import { Router } from 'express';
import prisma from '../lib/prisma';
import { asyncHandler, success, AppError } from '../utils/response';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';
import { findPacienteByUserId, findProfesionalByUserId } from '../utils/auth-helpers';
import { addMonthsToClinicMonth, getClinicDateTimeParts, getClinicMonthBounds } from '../utils/clinic-time';

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
  const profesional = await findProfesionalByUserId(userId);

  const paciente = await prisma.paciente.findUnique({
    where: { id: pacienteId },
  });

  if (!paciente) {
    throw new AppError(404, 'NOT_FOUND', 'Paciente no encontrado');
  }

  // Only a real consult (confirmed or completed) grants access to clinical history.
  // A bare RESERVADO that was never honored — or a CANCELADO/AUSENTE turno — must NOT
  // give a professional permanent access to the patient's records.
  const hasRelationship = await prisma.turno.findFirst({
    where: {
      profesionalId: profesional.id,
      pacienteId,
      estado: { in: ['CONFIRMADO', 'COMPLETADO'] },
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

  const paciente = await findPacienteByUserId(req.user!.userId);

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
  const paciente = await findPacienteByUserId(req.user!.userId);

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
      evolucion: { select: { id: true, contenido: true, updatedAt: true } },
      archivos: {
        select: { id: true, tipo: true, nombreOriginal: true, url: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      },
      profesional: {
        select: {
          id: true, nombre: true, apellido: true,
          especialidad: { select: { nombre: true } },
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

router.get('/mis-recetas', authMiddleware('PACIENTE'), asyncHandler(async (req: AuthRequest, res) => {
  const paciente = await findPacienteByUserId(req.user!.userId);

  const turnos = await prisma.turno.findMany({
    where: {
      pacienteId: paciente.id,
      recetaIndicacion: { isNot: null },
    },
    include: {
      recetaIndicacion: true, // every field is projected below — keep
      profesional: {
        select: {
          nombre: true, apellido: true, fotoUrl: true,
          especialidad: { select: { nombre: true } },
        },
      },
    },
    orderBy: { fechaHora: 'desc' },
  });

  const recetas = turnos.map((turno) => ({
    turnoId: turno.id,
    fechaHora: turno.fechaHora.toISOString(),
    profesional: {
      nombre: turno.profesional.nombre,
      apellido: turno.profesional.apellido,
      especialidad: turno.profesional.especialidad.nombre,
      fotoUrl: turno.profesional.fotoUrl,
    },
    receta: {
      diagnostico: turno.recetaIndicacion!.diagnostico,
      medicamentos: turno.recetaIndicacion!.medicamentos,
      indicaciones: turno.recetaIndicacion!.indicaciones,
      planTratamiento: turno.recetaIndicacion!.planTratamiento,
      estudiosSolicitados: turno.recetaIndicacion!.estudiosSolicitados,
      proximoControl: turno.recetaIndicacion!.proximoControl ? new Date(turno.recetaIndicacion!.proximoControl).toISOString() : null,
      advertencias: turno.recetaIndicacion!.advertencias,
      observaciones: turno.recetaIndicacion!.observaciones,
      emitidaAt: turno.recetaIndicacion!.emitidaAt.toISOString(),
    },
  }));

  res.json(success({ recetas }));
}));

router.get('/mis-certificados', authMiddleware('PACIENTE'), asyncHandler(async (req: AuthRequest, res) => {
  const paciente = await findPacienteByUserId(req.user!.userId);

  const turnos = await prisma.turno.findMany({
    where: {
      pacienteId: paciente.id,
      certificado: { isNot: null },
    },
    include: {
      certificado: true, // every field is projected below — keep
      profesional: { select: { nombre: true, apellido: true } },
    },
    orderBy: { fechaHora: 'desc' },
  });

  const certificados = turnos.map((turno) => ({
    turnoId: turno.id,
    fechaHora: turno.fechaHora.toISOString(),
    profesional: {
      nombre: turno.profesional.nombre,
      apellido: turno.profesional.apellido,
    },
    certificado: {
      id: turno.certificado!.id,
      tipo: turno.certificado!.tipo,
      diagnostico: turno.certificado!.diagnostico,
      texto: turno.certificado!.texto,
      diasReposo: turno.certificado!.diasReposo,
      turnoId: turno.certificado!.turnoId,
      emitidaAt: turno.certificado!.emitidaAt.toISOString(),
      createdAt: turno.certificado!.createdAt.toISOString(),
    },
  }));

  res.json(success({ certificados }));
}));

router.get('/mis-stats', authMiddleware('PACIENTE'), asyncHandler(async (req: AuthRequest, res) => {
  const paciente = await findPacienteByUserId(req.user!.userId);

  const ahora = new Date();
  const clinicNow = getClinicDateTimeParts(ahora);
  const startMonth = addMonthsToClinicMonth(clinicNow.year, clinicNow.month, -11);
  const { start: hace12Meses } = getClinicMonthBounds(startMonth.year, startMonth.month);
  const { end: finMesActual } = getClinicMonthBounds(clinicNow.year, clinicNow.month);

  const [turnosPorEstado, turnosConProf, pagos, turnosPorMesRaw] = await Promise.all([
    // Totals by status
    prisma.turno.groupBy({
      by: ['estado'],
      where: { pacienteId: paciente.id },
      _count: { id: true },
    }),
    // Most-visited professionals (top 5)
    prisma.turno.groupBy({
      by: ['profesionalId'],
      where: { pacienteId: paciente.id, estado: { notIn: ['CANCELADO'] } },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: 5,
    }),
    // All approved payments
    prisma.pago.findMany({
      where: {
        turno: { pacienteId: paciente.id },
        estado: 'APROBADO',
      },
      include: {
        turno: {
          select: {
            profesional: {
              select: {
                nombre: true, apellido: true,
                especialidad: { select: { nombre: true } },
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    }),
    // Turnos per month (last 12 months)
    prisma.turno.findMany({
      where: {
        pacienteId: paciente.id,
        fechaHora: { gte: hace12Meses, lt: finMesActual },
        estado: { notIn: ['CANCELADO'] },
      },
      select: { fechaHora: true, estado: true },
    }),
  ]);

  // Resolve professional names for top-visited
  const profIds = turnosConProf.map((t) => t.profesionalId);
  const profData = profIds.length
    ? await prisma.profesional.findMany({
        where: { id: { in: profIds } },
        select: { id: true, nombre: true, apellido: true, fotoUrl: true, especialidad: { select: { nombre: true } } },
      })
    : [];
  const profMap = new Map(profData.map((p) => [p.id, p]));

  const topProfesionales = turnosConProf.map((t) => ({
    profesional: profMap.get(t.profesionalId) ?? null,
    totalTurnos: t._count.id,
  })).filter((t) => t.profesional !== null);

  // Build monthly series
  const monthlyMap = new Map<string, number>();
  for (const t of turnosPorMesRaw) {
    const parts = getClinicDateTimeParts(t.fechaHora);
    const key = `${parts.year}-${String(parts.month).padStart(2, '0')}`;
    monthlyMap.set(key, (monthlyMap.get(key) ?? 0) + 1);
  }
  const turnosPorMes = Array.from(monthlyMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([mes, total]) => ({ mes, total }));

  // Status counts
  const byEstado = Object.fromEntries(turnosPorEstado.map((e) => [e.estado, e._count.id]));
  const totalTurnos = turnosPorEstado.reduce((acc, e) => acc + e._count.id, 0);
  const totalGastado = pagos.reduce((acc, p) => acc + Number(p.monto), 0);

  res.json(success({
    totalTurnos,
    completados: byEstado['COMPLETADO'] ?? 0,
    cancelados: byEstado['CANCELADO'] ?? 0,
    confirmados: byEstado['CONFIRMADO'] ?? 0,
    reservados: byEstado['RESERVADO'] ?? 0,
    totalGastado,
    pagos: pagos.map((p) => ({
      id: p.id,
      monto: Number(p.monto),
      fecha: p.createdAt,
      profesional: `${p.turno.profesional.nombre} ${p.turno.profesional.apellido}`,
      especialidad: p.turno.profesional.especialidad.nombre,
      mpPaymentId: p.mpPaymentId,
    })),
    topProfesionales,
    turnosPorMes,
  }));
}));

export { router as pacientesRouter };
