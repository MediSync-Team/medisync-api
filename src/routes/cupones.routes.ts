import { Router } from 'express';
import { AuthRequest, authMiddleware } from '../middleware/auth.middleware';
import { asyncHandler } from '../middleware/async-handler';
import { AppError } from '../utils/errors';
import { prisma } from '../db';

export const cuponesRouter = Router();

// POST /cupones — create coupon (PROFESIONAL)
cuponesRouter.post(
  '/',
  authMiddleware('PROFESIONAL'),
  asyncHandler(async (req: AuthRequest, res) => {
    const { codigo, tipo, valor, descripcion, maxUsos, expiresAt } = req.body;
    const profesionalId = req.user!.profesional!.id;

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

    res.json({ success: true, data: cupon });
  })
);

// GET /cupones — list professional's coupons (PROFESIONAL)
cuponesRouter.get(
  '/',
  authMiddleware('PROFESIONAL'),
  asyncHandler(async (req: AuthRequest, res) => {
    const profesionalId = req.user!.profesional!.id;

    const cupones = await prisma.cupon.findMany({
      where: { profesionalId },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ success: true, data: cupones });
  })
);

// PATCH /cupones/:id — update coupon (PROFESIONAL)
cuponesRouter.patch(
  '/:id',
  authMiddleware('PROFESIONAL'),
  asyncHandler(async (req: AuthRequest, res) => {
    const { id } = req.params;
    const { activo, descripcion, maxUsos, expiresAt } = req.body;
    const profesionalId = req.user!.profesional!.id;

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

    res.json({ success: true, data: updated });
  })
);

// DELETE /cupones/:id — delete coupon (PROFESIONAL)
cuponesRouter.delete(
  '/:id',
  authMiddleware('PROFESIONAL'),
  asyncHandler(async (req: AuthRequest, res) => {
    const { id } = req.params;
    const profesionalId = req.user!.profesional!.id;

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
    } else {
      // Hard delete
      await prisma.cupon.delete({ where: { id } });
    }

    res.json({ success: true, data: null });
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

    // Get turno with profesional and precio
    const turno = await prisma.turno.findUnique({
      where: { id: turnoId },
      include: { profesional: true },
    });
    if (!turno) {
      throw new AppError(404, 'NOT_FOUND', 'Turno no encontrado');
    }

    const codigoUpper = codigo.toUpperCase();
    const cupon = await prisma.cupon.findUnique({ where: { codigo: codigoUpper } });

    if (!cupon) {
      throw new AppError(400, 'INVALID_COUPON', 'El código de cupón no es válido');
    }
    if (!cupon.activo) {
      throw new AppError(400, 'INACTIVE_COUPON', 'El cupón está inactivo');
    }
    if (cupon.profesionalId !== turno.profesionalId) {
      throw new AppError(400, 'COUPON_NOT_FOR_PROFESSIONAL', 'El cupón no es válido para este profesional');
    }
    if (cupon.expiresAt && cupon.expiresAt < new Date()) {
      throw new AppError(400, 'EXPIRED_COUPON', 'El cupón ha expirado');
    }
    if (cupon.maxUsos && cupon.usosActuales >= cupon.maxUsos) {
      throw new AppError(400, 'COUPON_EXHAUSTED', 'El cupón ha alcanzado el máximo de usos');
    }

    // Calculate discount
    const montoOriginal = parseFloat(String(turno.profesional?.precioConsulta || 0));
    let montoDescuento = 0;
    if (cupon.tipo === 'PORCENTAJE') {
      montoDescuento = (montoOriginal * parseFloat(String(cupon.valor))) / 100;
    } else {
      montoDescuento = parseFloat(String(cupon.valor));
    }
    const montoFinal = Math.max(0, montoOriginal - montoDescuento);

    res.json({
      success: true,
      data: {
        cuponId: cupon.id,
        descripcion: cupon.descripcion,
        tipo: cupon.tipo,
        valor: cupon.valor,
        montoOriginal,
        montoDescuento,
        montoFinal,
      },
    });
  })
);
