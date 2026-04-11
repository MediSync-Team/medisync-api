import { Router } from 'express';
import prisma from '../lib/prisma';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler, AppError, success } from '../utils/response';

const router = Router();

router.get('/mis-suscripciones', authMiddleware('PACIENTE'), asyncHandler(async (req: AuthRequest, res) => {
  const paciente = await prisma.paciente.findUnique({
    where: { usuarioId: req.user!.userId },
  });

  if (!paciente) {
    throw new AppError(404, 'NOT_FOUND', 'Paciente no encontrado');
  }

  const items = await prisma.listaEspera.findMany({
    where: {
      pacienteId: paciente.id,
      estado: { in: ['ACTIVA', 'NOTIFICADA'] },
    },
    include: {
      profesional: {
        include: {
          especialidad: true,
        },
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
  });

  res.json(success(items));
}));

router.post('/suscribirme', authMiddleware('PACIENTE'), asyncHandler(async (req: AuthRequest, res) => {
  const { profesionalId, fecha, modalidad } = req.body;

  if (!profesionalId || !fecha || !modalidad) {
    throw new AppError(400, 'VALIDATION_ERROR', 'profesionalId, fecha y modalidad son requeridos');
  }

  if (!['PRESENCIAL', 'VIRTUAL'].includes(modalidad)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Modalidad invalida');
  }

  const fechaObjetivo = new Date(String(fecha));
  if (Number.isNaN(fechaObjetivo.getTime())) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Fecha invalida');
  }
  fechaObjetivo.setUTCHours(0, 0, 0, 0);

  const paciente = await prisma.paciente.findUnique({
    where: { usuarioId: req.user!.userId },
  });

  if (!paciente) {
    throw new AppError(404, 'NOT_FOUND', 'Paciente no encontrado');
  }

  const profesional = await prisma.profesional.findUnique({
    where: { id: String(profesionalId) },
  });

  if (!profesional || !profesional.activo) {
    throw new AppError(404, 'NOT_FOUND', 'Profesional no encontrado');
  }

  const existente = await prisma.listaEspera.findFirst({
    where: {
      profesionalId: profesional.id,
      pacienteId: paciente.id,
      fecha: fechaObjetivo,
      modalidad,
      estado: { in: ['ACTIVA', 'NOTIFICADA'] },
    },
  });

  if (existente) {
    throw new AppError(409, 'ALREADY_SUBSCRIBED', 'Ya estas en la lista de espera para ese dia');
  }

  const item = await prisma.listaEspera.create({
    data: {
      profesionalId: profesional.id,
      pacienteId: paciente.id,
      fecha: fechaObjetivo,
      modalidad,
      estado: 'ACTIVA',
    },
  });

  res.status(201).json(success(item));
}));

router.delete('/:id', authMiddleware('PACIENTE'), asyncHandler(async (req: AuthRequest, res) => {
  const paciente = await prisma.paciente.findUnique({
    where: { usuarioId: req.user!.userId },
  });

  if (!paciente) {
    throw new AppError(404, 'NOT_FOUND', 'Paciente no encontrado');
  }

  const item = await prisma.listaEspera.findUnique({
    where: { id: req.params.id },
  });

  if (!item || item.pacienteId !== paciente.id) {
    throw new AppError(404, 'NOT_FOUND', 'Suscripcion no encontrada');
  }

  const updated = await prisma.listaEspera.update({
    where: { id: item.id },
    data: { estado: 'CANCELADA' },
  });

  res.json(success(updated));
}));

export { router as listaEsperaRouter };
