import { Router } from 'express';
import prisma from '../lib/prisma';
import { asyncHandler, success, AppError } from '../utils/response';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';
import { createPaymentPreference } from '../services/pagos/payment.service';
import { processPaymentWebhook } from '../services/pagos/webhook.service';
import { refundPagoForTurno } from '../services/pagos/refund.service';
import { getPagoEstado, confirmarPago } from '../services/pagos/pago-query.service';

const router = Router();

/**
 * Build the MercadoPago webhook URL from the trusted `BACKEND_URL` only.
 * Falling back to the request `Host` header would let an attacker point MP's
 * callback at an arbitrary server (SSRF / payment-data leak), so the fallback is
 * allowed in non-production environments only.
 */
function resolveWebhookUrl(req: AuthRequest): string {
  const base = process.env.BACKEND_URL?.replace(/\/+$/, '');
  if (base) {
    return `${base}/api/pagos/webhook`;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new AppError(500, 'CONFIG_ERROR', 'BACKEND_URL no está configurado en el servidor');
  }
  return `${req.protocol}://${req.get('host')}/api/pagos/webhook`;
}

router.post(
  '/crear-preferencia',
  authMiddleware('PACIENTE'),
  asyncHandler(async (req: AuthRequest, res) => {
    const { turnoId, cuponCodigo } = req.body;
    const notificationUrl = resolveWebhookUrl(req);

    const result = await createPaymentPreference({
      userId: req.user!.userId,
      turnoId,
      cuponCodigo,
      notificationUrl,
    });

    if (result.kind === 'free_confirmed') {
      res.json(success({ necesitaPago: false, mensaje: 'Turno confirmado sin pago', estado: 'APROBADO' }));
      return;
    }

    if (result.kind === 'preference') {
      res.json(success({
        necesitaPago: true,
        preferenciaId: result.preferenciaId,
        initPoint: result.initPoint,
        estado: 'PENDIENTE',
      }));
      return;
    }

    res.json(success({ necesitaPago: false, mensaje: 'El turno ya se encuentra abonado' }));
  })
);

router.post('/webhook', asyncHandler(async (req, res) => {
  await processPaymentWebhook({
    body: req.body,
    signature: req.headers['x-signature'] as string | undefined,
    requestId: req.headers['x-request-id'] as string | undefined,
    turnoId: typeof req.query.turnoId === 'string' ? req.query.turnoId : undefined,
  });

  res.json(success({ received: true }));
}));

router.get('/estado/:turnoId', authMiddleware(), asyncHandler(async (req: AuthRequest, res) => {
  const result = await getPagoEstado({ userId: req.user!.userId, turnoId: req.params.turnoId });
  res.json(success(result));
}));

// Reintento manual del reembolso cuando el automático falló al cancelar (o
// para reembolsar un turno cancelado antes de que existiera el flujo automático).
router.post('/:turnoId/reembolsar', authMiddleware(['PROFESIONAL', 'ADMIN']), asyncHandler(async (req: AuthRequest, res) => {
  const { turnoId } = req.params;

  const turno = await prisma.turno.findUnique({
    where: { id: turnoId },
    select: { estado: true, profesional: { select: { usuarioId: true } } },
  });
  if (!turno) {
    throw new AppError(404, 'NOT_FOUND', 'Turno no encontrado');
  }

  if (req.user!.rol === 'PROFESIONAL' && turno.profesional.usuarioId !== req.user!.userId) {
    throw new AppError(403, 'FORBIDDEN', 'Sin permisos para reembolsar este turno');
  }

  // Reembolsar un turno vigente dejaría un turno confirmado sin pago detrás.
  if (turno.estado !== 'CANCELADO') {
    throw new AppError(400, 'INVALID_STATE', 'Solo se pueden reembolsar turnos cancelados');
  }

  const resultado = await refundPagoForTurno(turnoId, { motivo: 'Reembolso solicitado por el profesional' });

  if (resultado === 'failed') {
    throw new AppError(502, 'MP_ERROR', 'Mercado Pago no aceptó el reembolso; reintentá más tarde');
  }

  res.json(success({ resultado }));
}));

router.post('/confirmar-pago', authMiddleware('PACIENTE'), asyncHandler(async (req: AuthRequest, res) => {
  const turnoId = req.query.turnoId as string;
  if (!turnoId) {
    throw new AppError(400, 'MISSING_PARAM', 'turnoId es requerido');
  }

  const result = await confirmarPago({ userId: req.user!.userId, turnoId });
  res.json(success(result));
}));

export { router as pagosRouter };
