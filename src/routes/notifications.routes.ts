import { Router } from 'express';
import prisma from '../lib/prisma';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';
import { asyncHandler, success, AppError } from '../utils/response';
import { sendNotification } from '../utils/notifications';
import { addSseClient, removeSseClient } from '../services/notification.service';
import { verifyToken } from '../middleware/auth.middleware';

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

// ── GET /api/notifications/stream ───────────────────────────────────────────
// SSE endpoint — keeps connection alive and pushes new notifications in real time.
// EventSource cannot set headers, so we accept the JWT via ?token= query param as fallback.

router.get('/stream', (req: AuthRequest, res) => {
  // Try Authorization header first, then ?token= query param (needed for EventSource)
  let userId: string;
  const authHeader = req.headers.authorization;
  const queryToken = typeof req.query.token === 'string' ? req.query.token : null;

  try {
    const raw = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : queryToken;
    if (!raw) { res.status(401).end(); return; }
    const payload = verifyToken(raw);
    userId = payload.userId;
  } catch {
    res.status(401).end();
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // for nginx proxies
  res.flushHeaders();

  // Send initial heartbeat so the client knows the connection is live
  res.write(': connected\n\n');

  addSseClient(userId, res);

  // Heartbeat every 25 s to prevent proxy timeouts
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* ignore */ }
  }, 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    removeSseClient(userId, res);
  });
});

// ── GET /api/notifications/inbox ────────────────────────────────────────────
// Returns the last 50 notifications for the authenticated user.
router.get('/inbox', authMiddleware(), asyncHandler(async (req: AuthRequest, res) => {
  const userId = req.user!.userId;
  const notifs = await prisma.notificacion.findMany({
    where: { usuarioId: userId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  const unread = notifs.filter(n => !n.leida).length;
  res.json(success({ notifs, unread }));
}));

// ── PATCH /api/notifications/:id/read ───────────────────────────────────────
// Marks a single notification as read.
router.patch('/:id/read', authMiddleware(), asyncHandler(async (req: AuthRequest, res) => {
  const userId = req.user!.userId;
  const { id } = req.params;

  const notif = await prisma.notificacion.findUnique({ where: { id } });
  if (!notif) throw new AppError(404, 'NOT_FOUND', 'Notificación no encontrada');
  if (notif.usuarioId !== userId) throw new AppError(403, 'FORBIDDEN', 'Sin permisos');

  const updated = await prisma.notificacion.update({ where: { id }, data: { leida: true } });
  res.json(success(updated));
}));

// ── PATCH /api/notifications/read-all ───────────────────────────────────────
// Marks all unread notifications for the user as read.
router.patch('/read-all', authMiddleware(), asyncHandler(async (req: AuthRequest, res) => {
  const userId = req.user!.userId;
  const { count } = await prisma.notificacion.updateMany({
    where: { usuarioId: userId, leida: false },
    data: { leida: true },
  });
  res.json(success({ marked: count }));
}));

export { router as notificationsRouter };
