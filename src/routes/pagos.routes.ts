import { Router } from 'express';
import { asyncHandler, success } from '../utils/response';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

router.post('/crear-preferencia', authMiddleware(), asyncHandler(async (req, res) => {
  // TODO: Implementar Mercado Pago
  res.json(success({ preferenciaId: 'mock-pref', initPoint: 'https://mercadopago.com/mock' }));
}));

router.post('/webhook', asyncHandler(async (req, res) => {
  // TODO: Implementar webhook de Mercado Pago
  console.log('Webhook recibido:', req.body);
  res.json(success({ received: true }));
}));

router.get('/turno/:turnoId', authMiddleware(), asyncHandler(async (req, res) => {
  // TODO: Obtener estado de pago
  res.json(success({ estado: 'PENDIENTE' }));
}));

export { router as pagosRouter };
