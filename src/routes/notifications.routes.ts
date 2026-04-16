import { Router } from 'express';
import prisma from '../lib/prisma';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler, success, AppError } from '../utils/response';
import { sendNotification } from '../utils/notifications';

const router = Router();
const ALLOWED_CHANNELS = ['EMAIL', 'WHATSAPP', 'IN_APP'] as const;
type AllowedChannel = typeof ALLOWED_CHANNELS[number];

// ── GET /api/notifications/preferences ─────────────────────────────────────
// Devuelve las preferencias de notificación del usuario autenticado.
router.get('/preferences', authMiddleware(), asyncHandler(async (req: AuthRequest, res) => {
  const userId = req.user!.userId;
  const rol    = req.user!.rol;

  if (rol === 'PACIENTE') {
    const paciente = await prisma.paciente.findUnique({
      where: { usuarioId: userId },
      select: {
        aceptaRecordatorios: true,
        notifEmail: true,
        notifWhatsapp: true,
        notifRecordatorio24h: true,
        notifRecordatorio2h: true,
      },
    });
    if (!paciente) throw new AppError(404, 'NOT_FOUND', 'Paciente no encontrado');
    res.json(success(paciente));
    return;
  }

  // PROFESIONAL
  const profesional = await prisma.profesional.findUnique({
    where: { usuarioId: userId },
    select: {
      notifEmail: true,
      notifWhatsapp: true,
    },
  });
  if (!profesional) throw new AppError(404, 'NOT_FOUND', 'Profesional no encontrado');
  res.json(success(profesional));
}));

// ── PUT /api/notifications/preferences ─────────────────────────────────────
// Actualiza las preferencias del usuario autenticado.
router.put('/preferences', authMiddleware(), asyncHandler(async (req: AuthRequest, res) => {
  const userId = req.user!.userId;
  const rol    = req.user!.rol;
  const body   = req.body as Record<string, unknown>;

  const toBool = (val: unknown, fallback: boolean): boolean =>
    typeof val === 'boolean' ? val : fallback;

  if (rol === 'PACIENTE') {
    const paciente = await prisma.paciente.findUnique({ where: { usuarioId: userId } });
    if (!paciente) throw new AppError(404, 'NOT_FOUND', 'Paciente no encontrado');

    const updated = await prisma.paciente.update({
      where: { usuarioId: userId },
      data: {
        aceptaRecordatorios:  toBool(body.aceptaRecordatorios,  paciente.aceptaRecordatorios),
        notifEmail:           toBool(body.notifEmail,           paciente.notifEmail),
        notifWhatsapp:        toBool(body.notifWhatsapp,        paciente.notifWhatsapp),
        notifRecordatorio24h: toBool(body.notifRecordatorio24h, paciente.notifRecordatorio24h),
        notifRecordatorio2h:  toBool(body.notifRecordatorio2h,  paciente.notifRecordatorio2h),
      },
      select: {
        aceptaRecordatorios: true,
        notifEmail: true,
        notifWhatsapp: true,
        notifRecordatorio24h: true,
        notifRecordatorio2h: true,
      },
    });
    res.json(success(updated));
    return;
  }

  // PROFESIONAL
  const profesional = await prisma.profesional.findUnique({ where: { usuarioId: userId } });
  if (!profesional) throw new AppError(404, 'NOT_FOUND', 'Profesional no encontrado');

  const updatedProf = await prisma.profesional.update({
    where: { usuarioId: userId },
    data: {
      notifEmail:    toBool(body.notifEmail,    profesional.notifEmail),
      notifWhatsapp: toBool(body.notifWhatsapp, profesional.notifWhatsapp),
    },
    select: {
      notifEmail: true,
      notifWhatsapp: true,
    },
  });
  res.json(success(updatedProf));
}));

// ── POST /api/notifications/test ────────────────────────────────────────────
// Envía una notificación de prueba al usuario autenticado.
router.post('/test', authMiddleware(), asyncHandler(async (req: AuthRequest, res) => {
  const { canal, mensaje } = req.body;
  const channel = (canal || 'EMAIL') as string;
  const text = mensaje || 'Notificación de prueba MediSync';

  if (!ALLOWED_CHANNELS.includes(channel as AllowedChannel)) {
    res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: `Canal inválido. Usá uno de: ${ALLOWED_CHANNELS.join(', ')}`,
      },
    });
    return;
  }

  if (!req.user) {
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'No autenticado' } });
    return;
  }

  // Fetch phone number so WhatsApp test can work
  let userPhone: string | null | undefined;
  if (req.user.rol === 'PACIENTE') {
    const paciente = await prisma.paciente.findUnique({ where: { usuarioId: req.user.userId }, select: { telefono: true } });
    userPhone = paciente?.telefono;
  } else {
    const profesional = await prisma.profesional.findUnique({ where: { usuarioId: req.user.userId }, select: { telefono: true } });
    userPhone = profesional?.telefono;
  }

  await sendNotification([channel as AllowedChannel], {
    event: 'PRUEBA',
    title: 'Prueba de notificación',
    message: text,
    userEmail: req.user.email,
    userPhone: userPhone ?? undefined,
    meta: {
      requestedBy: req.user.userId,
      channel,
      createdAt: new Date().toISOString(),
    },
  });

  res.json(success({ ok: true, channel }));
}));

export { router as notificationsRouter };
