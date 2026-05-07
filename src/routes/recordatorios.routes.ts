import { Router } from 'express';
import prisma from '../lib/prisma';
import { asyncHandler, success, AppError } from '../utils/response';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';

const router = Router();

router.get('/profesional', authMiddleware('PROFESIONAL'), asyncHandler(async (req: AuthRequest, res) => {
  const profesional = await prisma.profesional.findUnique({
    where: { usuarioId: req.user!.userId },
  });

  if (!profesional) {
    throw new AppError(404, 'NOT_FOUND', 'Profesional no encontrado');
  }

  const now = new Date();
  const manana = new Date(now);
  manana.setDate(manana.getDate() + 1);
  manana.setHours(23, 59, 59, 999);

  const turnosManana = await prisma.turno.findMany({
    where: {
      profesionalId: profesional.id,
      fechaHora: {
        gte: now,
        lte: manana,
      },
      estado: { in: ['RESERVADO', 'CONFIRMADO'] },
    },
    include: {
      paciente: true,
    },
    orderBy: { fechaHora: 'asc' },
  });

  res.json(success({
    total: turnosManana.length,
    turnos: turnosManana.map(t => ({
      id: t.id,
      fechaHora: t.fechaHora,
      modalidad: t.modalidad,
      estado: t.estado,
      paciente: t.paciente ? {
        nombre: t.paciente.nombre,
        apellido: t.paciente.apellido,
        telefono: t.paciente.telefono,
        email: t.paciente.email,
      } : null,
    })),
  }));
}));

router.get('/paciente', authMiddleware('PACIENTE'), asyncHandler(async (req: AuthRequest, res) => {
  const paciente = await prisma.paciente.findUnique({
    where: { usuarioId: req.user!.userId },
  });

  if (!paciente) {
    throw new AppError(404, 'NOT_FOUND', 'Paciente no encontrado');
  }

  const now = new Date();
  const en24hs = new Date(now);
  en24hs.setHours(en24hs.getHours() + 24);

  const turnosProximos = await prisma.turno.findMany({
    where: {
      pacienteId: paciente.id,
      fechaHora: {
        gte: now,
        lte: en24hs,
      },
      estado: { in: ['RESERVADO', 'CONFIRMADO'] },
    },
    include: {
      profesional: {
        include: { especialidad: true },
      },
    },
    orderBy: { fechaHora: 'asc' },
  });

  res.json(success({
    total: turnosProximos.length,
    turnos: turnosProximos.map(t => ({
      id: t.id,
      fechaHora: t.fechaHora,
      modalidad: t.modalidad,
      estado: t.estado,
      linkVideollamada: t.linkVideollamada,
      profesional: {
        nombre: t.profesional.nombre,
        apellido: t.profesional.apellido,
        especialidad: t.profesional.especialidad.nombre,
        telefono: t.profesional.telefono,
        lugarAtencion: t.profesional.lugarAtencion,
      },
    })),
  }));
}));

export { router as recordatoriosRouter };
