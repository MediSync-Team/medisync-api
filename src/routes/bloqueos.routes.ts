import { Router } from 'express';
import prisma from '../lib/prisma';
import { asyncHandler, success, AppError } from '../utils/response';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';
import { sendNotification, resolveChannels } from '../utils/notifications';
import { createNotification } from '../services/notification.service';
import { findProfesionalByUserId } from '../utils/auth-helpers';
import {
  clinicDateTimeToUtcDate,
  formatClinicDateKey,
  formatClinicDateTimeEs,
  getClinicDateOnlyUtc,
  getClinicDayBoundsFromDateString,
} from '../utils/clinic-time';

const router = Router();

function normalizeClinicDateInput(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Fechas inválidas');
  }
  return formatClinicDateKey(parsed);
}

function buildBlockRange(inicio: string, fin: string, horaInicio?: string | null, horaFin?: string | null) {
  if (horaInicio && horaFin) {
    return {
      start: clinicDateTimeToUtcDate(inicio, horaInicio),
      end: clinicDateTimeToUtcDate(fin, horaFin),
    };
  }

  const start = getClinicDayBoundsFromDateString(inicio).start;
  const end = getClinicDayBoundsFromDateString(fin).end;
  return { start, end };
}

// GET /api/bloqueos — lista de bloqueos del profesional autenticado
router.get('/', authMiddleware('PROFESIONAL'), asyncHandler(async (req: AuthRequest, res) => {
  const profesional = await findProfesionalByUserId(req.user!.userId);

  const { soloFuturos = 'true' } = req.query;
  const where: any = { profesionalId: profesional.id };
  if (soloFuturos === 'true') {
    const hoy = getClinicDayBoundsFromDateString(formatClinicDateKey(new Date())).start;
    where.fechaFin = { gte: hoy };
  }

  const bloqueos = await prisma.bloqueoDisponibilidad.findMany({
    where,
    orderBy: { fechaInicio: 'asc' },
  });

  res.json(success(bloqueos));
}));

// POST /api/bloqueos — crear un bloqueo
router.post('/', authMiddleware('PROFESIONAL'), asyncHandler(async (req: AuthRequest, res) => {
  const { fechaInicio, fechaFin, horaInicio, horaFin, motivo } = req.body;

  if (!fechaInicio || !fechaFin) {
    throw new AppError(400, 'VALIDATION_ERROR', 'fechaInicio y fechaFin son requeridos');
  }

  const inicioKey = normalizeClinicDateInput(String(fechaInicio));
  const finKey = normalizeClinicDateInput(String(fechaFin));
  const inicio = getClinicDateOnlyUtc(inicioKey);
  const fin = getClinicDateOnlyUtc(finKey);
  if (finKey < inicioKey) {
    throw new AppError(400, 'VALIDATION_ERROR', 'fechaFin debe ser mayor o igual a fechaInicio');
  }

  // If partial day, both hours must be provided and start < end
  if (horaInicio || horaFin) {
    if (!horaInicio || !horaFin) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Si especificás hora parcial, ambas horaInicio y horaFin son requeridas');
    }
    const [hi, mi] = horaInicio.split(':').map(Number);
    const [hf, mf] = horaFin.split(':').map(Number);
    if (isNaN(hi) || isNaN(mi) || isNaN(hf) || isNaN(mf) || hi * 60 + mi >= hf * 60 + mf) {
      throw new AppError(400, 'VALIDATION_ERROR', 'horaInicio debe ser menor a horaFin');
    }
    // Partial-day bloqueo only supports single-day
    if (inicioKey !== finKey) {
      throw new AppError(400, 'VALIDATION_ERROR', 'El bloqueo parcial por hora solo puede aplicarse a un único día');
    }
  }

  const profesional = await findProfesionalByUserId(req.user!.userId);

  const result = await prisma.$transaction(async (tx) => {
    const bloqueo = await tx.bloqueoDisponibilidad.create({
      data: {
        profesionalId: profesional.id,
        fechaInicio: inicio,
        fechaFin: fin,
        horaInicio: horaInicio || null,
        horaFin: horaFin || null,
        motivo: motivo?.trim() || null,
      },
    });

    const { start, end } = buildBlockRange(inicioKey, finKey, horaInicio, horaFin);

    const turnosAfectados = await tx.turno.findMany({
      where: {
        profesionalId: profesional.id,
        estado: { in: ['RESERVADO', 'CONFIRMADO'] },
        fechaHora: { gte: start, lt: end },
      },
      include: { paciente: true, profesional: { include: { usuario: true } } },
    });

    const notasCancelacion = `Turno cancelado por bloqueo de agenda del profesional${motivo ? ': ' + motivo : ''}.`;

    const cancelUpdates = turnosAfectados.map(t =>
      tx.turno.update({
        where: { id: t.id },
        data: { estado: 'CANCELADO', notasCancelacion },
      })
    );

    const auditTurnos = turnosAfectados.map(t =>
      tx.auditoriaDisponibilidad.create({
        data: {
          profesionalId: profesional.id,
          tipoEvento: 'TURNO_CANCELADO_POR_BLOQUEO',
          bloqueoId: bloqueo.id,
          turnoId: t.id,
          detalle: { fechaHora: t.fechaHora.toISOString(), pacienteId: t.pacienteId, motivo },
        },
      })
    );

    const auditBloqueo = tx.auditoriaDisponibilidad.create({
      data: {
        profesionalId: profesional.id,
        tipoEvento: 'BLOQUEO_CREADO',
        bloqueoId: bloqueo.id,
        detalle: { fechaInicio: inicio.toISOString(), fechaFin: fin.toISOString(), horaInicio, horaFin, motivo, turnosCancelados: turnosAfectados.length },
      },
    });

    await Promise.all([...cancelUpdates, ...auditTurnos, auditBloqueo]);

    return { bloqueo, turnosAfectados };
  });

  for (const turno of result.turnosAfectados) {
    if (!turno.paciente) continue;
    const channels = resolveChannels({
      notifEmail: turno.paciente.notifEmail,
      notifWhatsapp: turno.paciente.notifWhatsapp,
    });

    sendNotification(channels, {
      event: 'TURNO_CANCELADO',
      title: 'Turno cancelado',
      message: `Tu turno del ${formatClinicDateTimeEs(turno.fechaHora)} fue cancelado porque el profesional bloqueó esa agenda${motivo ? ': ' + motivo : ''}.`,
      userEmail: turno.paciente.email,
      meta: { turnoId: turno.id },
    }).catch(() => {});

    createNotification({
      usuarioId: turno.paciente.usuarioId,
      tipo: 'TURNO_CANCELADO',
      titulo: 'Turno cancelado',
      cuerpo: `Tu turno del ${formatClinicDateTimeEs(turno.fechaHora)} fue cancelado. Razón: ${motivo || 'bloqueo de agenda'}.`,
      link: '/dashboard/paciente',
    }).catch(() => {});
  }

  res.status(201).json(success(result.bloqueo));
}));

// DELETE /api/bloqueos/:id — eliminar un bloqueo
router.delete('/:id', authMiddleware('PROFESIONAL'), asyncHandler(async (req: AuthRequest, res) => {
  const profesional = await findProfesionalByUserId(req.user!.userId);

  const bloqueo = await prisma.bloqueoDisponibilidad.findUnique({ where: { id: req.params.id } });
  if (!bloqueo) throw new AppError(404, 'NOT_FOUND', 'Bloqueo no encontrado');
  if (bloqueo.profesionalId !== profesional.id) throw new AppError(403, 'FORBIDDEN', 'Sin permisos');

  await prisma.$transaction([
    prisma.bloqueoDisponibilidad.delete({ where: { id: req.params.id } }),
    prisma.auditoriaDisponibilidad.create({
      data: {
        profesionalId: profesional.id,
        tipoEvento: 'BLOQUEO_ELIMINADO',
        bloqueoId: req.params.id,
        detalle: { fechaInicio: bloqueo.fechaInicio.toISOString(), fechaFin: bloqueo.fechaFin.toISOString(), horaInicio: bloqueo.horaInicio, horaFin: bloqueo.horaFin, motivo: bloqueo.motivo },
      },
    }),
  ]);

  res.json(success({ deleted: true }));
}));

// Public: GET /api/bloqueos/profesional/:profesionalId — bloqueos de un profesional (para el booking)
router.get('/profesional/:profesionalId', asyncHandler(async (req, res) => {
  const { fecha } = req.query;
  if (!fecha) throw new AppError(400, 'VALIDATION_ERROR', 'fecha requerida');

  const fechaDate = getClinicDateOnlyUtc(String(fecha));

  const bloqueos = await prisma.bloqueoDisponibilidad.findMany({
    where: {
      profesionalId: req.params.profesionalId,
      fechaInicio: { lte: fechaDate },
      fechaFin: { gte: fechaDate },
    },
    select: { horaInicio: true, horaFin: true },
  });

  res.json(success(bloqueos));
}));

export { router as bloqueosRouter };
