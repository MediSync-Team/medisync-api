import { Router } from 'express';
import { AuthRequest, authMiddleware } from '../middleware/auth.middleware';
import { asyncHandler, success, AppError } from '../utils/response';
import prisma from '../lib/prisma';
import { getProfesionalIdByUsuario } from '../utils/auth-helpers';
import { validateAndApplyCoupon } from '../utils/coupon';

export const cuponesRouter = Router();

// POST /cupones — create coupon (PROFESIONAL)
cuponesRouter.post(
  '/',
  authMiddleware('PROFESIONAL'),
  asyncHandler(async (req: AuthRequest, res) => {
    const { codigo, tipo, valor, descripcion, maxUsos, expiresAt } = req.body;
    const profesionalId = await getProfesionalIdByUsuario(req.user!.userId);
    if (!profesionalId) {
      throw new AppError(403, 'FORBIDDEN', 'Usuario no es profesional');
    }

    if (!codigo || !tipo || valor === undefined || valor === null) {
      throw new AppError(400, 'VALIDATION_ERROR', 'codigo, tipo y valor son obligatorios');
    }

    const codigoUpper = codigo.toUpperCase();
    const existing = await prisma.cupon.findUnique({ where: { codigo: codigoUpper } });
    if (existing) {
      throw new AppError(400, 'DUPLICATE_CODE', 'El código ya existe');
    }

    const cupon = await prisma.cupon.create({
      data: {
        profesionalId,
        codigo: codigoUpper,
        tipo,
        valor: typeof valor === 'string' ? parseFloat(valor) : valor,
        descripcion,
        maxUsos: maxUsos ? parseInt(maxUsos) : null,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
      },
    });

    res.json(success(cupon));
  })
);

// GET /cupones — list professional's coupons (PROFESIONAL)
cuponesRouter.get(
  '/',
  authMiddleware('PROFESIONAL'),
  asyncHandler(async (req: AuthRequest, res) => {
    const profesionalId = await getProfesionalIdByUsuario(req.user!.userId);
    if (!profesionalId) {
      throw new AppError(403, 'FORBIDDEN', 'Usuario no es profesional');
    }

    const cupones = await prisma.cupon.findMany({
      where: { profesionalId },
      orderBy: { createdAt: 'desc' },
    });

    res.json(success(cupones));
  })
);

// PATCH /cupones/:id — update coupon (PROFESIONAL)
cuponesRouter.patch(
  '/:id',
  authMiddleware('PROFESIONAL'),
  asyncHandler(async (req: AuthRequest, res) => {
    const { id } = req.params;
    const { activo, descripcion, maxUsos, expiresAt } = req.body;
    const profesionalId = await getProfesionalIdByUsuario(req.user!.userId);
    if (!profesionalId) {
      throw new AppError(403, 'FORBIDDEN', 'Usuario no es profesional');
    }

    const cupon = await prisma.cupon.findUnique({ where: { id } });
    if (!cupon) {
      throw new AppError(404, 'NOT_FOUND', 'Cupón no encontrado');
    }
    if (cupon.profesionalId !== profesionalId) {
      throw new AppError(403, 'FORBIDDEN', 'No tienes permisos para actualizar este cupón');
    }

    const updated = await prisma.cupon.update({
      where: { id },
      data: {
        activo: activo !== undefined ? activo : undefined,
        descripcion: descripcion !== undefined ? descripcion : undefined,
        maxUsos: maxUsos !== undefined ? (maxUsos ? parseInt(maxUsos) : null) : undefined,
        expiresAt: expiresAt !== undefined ? (expiresAt ? new Date(expiresAt) : null) : undefined,
      },
    });

    res.json(success(updated));
  })
);

// DELETE /cupones/:id — delete coupon (PROFESIONAL)
cuponesRouter.delete(
  '/:id',
  authMiddleware('PROFESIONAL'),
  asyncHandler(async (req: AuthRequest, res) => {
    const { id } = req.params;
    const profesionalId = await getProfesionalIdByUsuario(req.user!.userId);
    if (!profesionalId) {
      throw new AppError(403, 'FORBIDDEN', 'Usuario no es profesional');
    }

    const cupon = await prisma.cupon.findUnique({ where: { id } });
    if (!cupon) {
      throw new AppError(404, 'NOT_FOUND', 'Cupón no encontrado');
    }
    if (cupon.profesionalId !== profesionalId) {
      throw new AppError(403, 'FORBIDDEN', 'No tienes permisos para eliminar este cupón');
    }

    if (cupon.usosActuales > 0) {
      // Soft delete
      await prisma.cupon.update({
        where: { id },
        data: { activo: false },
      });
      res.json(success({ eliminado: false, motivo: 'Cupón con usos — archivado' }));
    } else {
      // Hard delete
      await prisma.cupon.delete({ where: { id } });
      res.json(success({ eliminado: true }));
    }
  })
);

// POST /cupones/validar — validate coupon (PACIENTE)
cuponesRouter.post(
  '/validar',
  authMiddleware('PACIENTE'),
  asyncHandler(async (req: AuthRequest, res) => {
    const { codigo, turnoId } = req.body;

    if (!codigo || !turnoId) {
      throw new AppError(400, 'VALIDATION_ERROR', 'codigo y turnoId son obligatorios');
    }

    const turno = await prisma.turno.findUnique({
      where: { id: turnoId },
      include: { paciente: true, profesional: true },
    });
    if (!turno) {
      throw new AppError(404, 'NOT_FOUND', 'Turno no encontrado');
    }
    if (!turno.paciente || turno.paciente.usuarioId !== req.user!.userId) {
      throw new AppError(403, 'FORBIDDEN', 'Sin permisos para validar cupones de este turno');
    }

    const precioBase = Number(turno.profesional?.precioConsulta || 0);
    const result = await validateAndApplyCoupon(codigo, turnoId, turno.profesionalId, precioBase);

    res.json(success(result));
  })
);
