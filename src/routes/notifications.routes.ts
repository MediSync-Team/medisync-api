import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler, success } from '../utils/response';
import { sendNotification } from '../utils/notifications';

const router = Router();

router.post('/test', authMiddleware(), asyncHandler(async (req: AuthRequest, res) => {
  const { canal, mensaje } = req.body;
  const channel = canal || 'EMAIL';
  const text = mensaje || 'Notificacion de prueba MediSync';

  if (!req.user) {
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'No autenticado' } });
    return;
  }

  await sendNotification([channel], {
    title: 'Prueba de notificacion',
    message: text,
    userEmail: req.user.email,
    meta: {
      requestedBy: req.user.userId,
      channel,
      createdAt: new Date().toISOString(),
    },
  });

  res.json(success({ ok: true, channel }));
}));

export { router as notificationsRouter };
