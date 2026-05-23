import { Router } from 'express';
import prisma from '../lib/prisma';
import { asyncHandler, success, AppError } from '../utils/response';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';
import { findProfesionalByUserId, findPacienteByUserId } from '../utils/auth-helpers';

const router = Router();

function getNext24HoursWindow(now = new Date()): { now: Date; end: Date } {
  return {
    now,
    end: new Date(now.getTime() + 24 * 60 * 60 * 1000),
  };
}

router.get('/profesional', authMiddleware('PROFESIONAL'), asyncHandler(async (req: AuthRequest, res) => {
  const profesional = await findProfesionalByUserId(req.user!.userId);

  const { now, end } = getNext24HoursWindow();

  const turnosManana = await prisma.turno.findMany({
    where: {
      profesionalId: profesional.id,
      fechaHora: {
        gte: now,
        lte: end,
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
  const paciente = await findPacienteByUserId(req.user!.userId);

  const { now, end } = getNext24HoursWindow();

  const turnosProximos = await prisma.turno.findMany({
    where: {
      pacienteId: paciente.id,
      fechaHora: {
        gte: now,
        lte: end,
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
