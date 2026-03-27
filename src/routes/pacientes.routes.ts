import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import prisma from '../lib/prisma';
import { asyncHandler, success, AppError } from '../utils/response';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';

const router = Router();

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

export { router as pacientesRouter };
