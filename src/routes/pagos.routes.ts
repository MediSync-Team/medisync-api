import { Router } from 'express';
import { asyncHandler, success, AppError } from '../utils/response';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';
import { createPaymentPreference } from '../services/pagos/payment.service';
import { processPaymentWebhook } from '../services/pagos/webhook.service';
import { getPagoEstado, confirmarPago } from '../services/pagos/pago-query.service';

const router = Router();

router.post(
  '/crear-preferencia',
  authMiddleware('PACIENTE'),
  asyncHandler(async (req: AuthRequest, res) => {
    const { turnoId, cuponCodigo } = req.body;
    const notificationUrl = `${process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`}/api/pagos/webhook`;

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
  });

  res.json(success({ received: true }));
}));

router.get('/estado/:turnoId', authMiddleware(), asyncHandler(async (req: AuthRequest, res) => {
  const result = await getPagoEstado({ userId: req.user!.userId, turnoId: req.params.turnoId });
  res.json(success(result));
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
