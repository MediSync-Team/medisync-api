import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler, success } from '../utils/response';
import { sendNotification } from '../utils/notifications';

const router = Router();
const ALLOWED_CHANNELS = ['EMAIL', 'WHATSAPP', 'IN_APP'] as const;
type AllowedChannel = typeof ALLOWED_CHANNELS[number];

router.post('/test', authMiddleware(), asyncHandler(async (req: AuthRequest, res) => {
  const { canal, mensaje } = req.body;
  const channel = (canal || 'EMAIL') as string;
  const text = mensaje || 'Notificacion de prueba MediSync';

  if (!ALLOWED_CHANNELS.includes(channel as AllowedChannel)) {
    res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: `Canal invalido. Usa uno de: ${ALLOWED_CHANNELS.join(', ')}`,
      },
    });
    return;
  }

  if (!req.user) {
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'No autenticado' } });
    return;
  }

  await sendNotification([channel as AllowedChannel], {
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
