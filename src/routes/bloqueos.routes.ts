import { Router } from 'express';
import prisma from '../lib/prisma';
import { asyncHandler, success, AppError } from '../utils/response';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';

const router = Router();

// GET /api/bloqueos — lista de bloqueos del profesional autenticado
router.get('/', authMiddleware('PROFESIONAL'), asyncHandler(async (req: AuthRequest, res) => {
  const profesional = await prisma.profesional.findUnique({ where: { usuarioId: req.user!.userId } });
  if (!profesional) throw new AppError(404, 'NOT_FOUND', 'Profesional no encontrado');

  const { soloFuturos = 'true' } = req.query;
  const where: any = { profesionalId: profesional.id };
  if (soloFuturos === 'true') {
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);
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

  const inicio = new Date(fechaInicio);
  const fin = new Date(fechaFin);
  if (isNaN(inicio.getTime()) || isNaN(fin.getTime())) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Fechas inválidas');
  }
  if (fin < inicio) {
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
    if (inicio.toDateString() !== fin.toDateString()) {
      throw new AppError(400, 'VALIDATION_ERROR', 'El bloqueo parcial por hora solo puede aplicarse a un único día');
    }
  }

  const profesional = await prisma.profesional.findUnique({ where: { usuarioId: req.user!.userId } });
  if (!profesional) throw new AppError(404, 'NOT_FOUND', 'Profesional no encontrado');

  const bloqueo = await prisma.bloqueoDisponibilidad.create({
    data: {
      profesionalId: profesional.id,
      fechaInicio: inicio,
      fechaFin: fin,
      horaInicio: horaInicio || null,
      horaFin: horaFin || null,
      motivo: motivo?.trim() || null,
    },
  });

  res.status(201).json(success(bloqueo));
}));

// DELETE /api/bloqueos/:id — eliminar un bloqueo
router.delete('/:id', authMiddleware('PROFESIONAL'), asyncHandler(async (req: AuthRequest, res) => {
  const profesional = await prisma.profesional.findUnique({ where: { usuarioId: req.user!.userId } });
  if (!profesional) throw new AppError(404, 'NOT_FOUND', 'Profesional no encontrado');

  const bloqueo = await prisma.bloqueoDisponibilidad.findUnique({ where: { id: req.params.id } });
  if (!bloqueo) throw new AppError(404, 'NOT_FOUND', 'Bloqueo no encontrado');
  if (bloqueo.profesionalId !== profesional.id) throw new AppError(403, 'FORBIDDEN', 'Sin permisos');

  await prisma.bloqueoDisponibilidad.delete({ where: { id: req.params.id } });
  res.json(success({ deleted: true }));
}));

// Public: GET /api/bloqueos/profesional/:profesionalId — bloqueos de un profesional (para el booking)
router.get('/profesional/:profesionalId', asyncHandler(async (req, res) => {
  const { fecha } = req.query;
  if (!fecha) throw new AppError(400, 'VALIDATION_ERROR', 'fecha requerida');

  const [y, m, d] = String(fecha).split('-').map(Number);
  const fechaDate = new Date(y, m - 1, d);

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
