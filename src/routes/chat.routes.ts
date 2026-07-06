import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import prisma from '../lib/prisma';
import { asyncHandler, success, AppError } from '../utils/response';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';
import { validateRequest } from '../utils/validation';
import { createNotification } from '../services/notification.service';

const router = Router();
router.use(authMiddleware());

/** Verify requesting user is paciente or profesional of the turno */
async function assertChatAccess(turnoId: string, req: AuthRequest, opts: { forWrite?: boolean } = {}) {
  const turno = await prisma.turno.findUnique({
    where: { id: turnoId },
    include: {
      paciente:    { select: { id: true, nombre: true, apellido: true, usuarioId: true } },
      profesional: { select: { id: true, nombre: true, apellido: true, usuarioId: true } },
    },
  });

  if (!turno) throw new AppError(404, 'NOT_FOUND', 'Turno no encontrado');

  const userId = req.user!.userId;
  const isPaciente    = turno.paciente?.usuarioId === userId;
  const isProfesional = turno.profesional.usuarioId === userId;

  if (!isPaciente && !isProfesional) {
    throw new AppError(403, 'FORBIDDEN', 'Sin permisos para acceder a este chat');
  }

  // Block *sending* on a cancelled turno, but still allow *reading* the history so
  // participants can review what was said (e.g. an in-call chat from before the
  // turno was cancelled for non-payment).
  if (opts.forWrite && turno.estado === 'CANCELADO') {
    throw new AppError(400, 'TURNO_CANCELADO', 'No se puede chatear en un turno cancelado');
  }

  return { turno, isPaciente, isProfesional };
}

// GET /api/chat/unread-global — total unread across all the user's turnos.
// Declared BEFORE '/:turnoId' so Express doesn't match "unread-global" as a turnoId.
router.get('/unread-global', asyncHandler(async (req: AuthRequest, res) => {
  const userId = req.user!.userId;
  const count = await prisma.chatMensaje.count({
    where: {
      remitenteId: { not: userId },
      leidoAt: null,
      turno: {
        estado: { not: 'CANCELADO' },
        OR: [
          { paciente: { usuarioId: userId } },
          { profesional: { usuarioId: userId } },
        ],
      },
    },
  });
  res.json(success({ count }));
}));

// GET /api/chat/:turnoId — list messages. Optional ?since=<ISO date> returns only
// messages strictly newer than that timestamp, for cheap incremental polling;
// an absent/invalid value falls back to the full last-200 behavior.
router.get('/:turnoId', asyncHandler(async (req: AuthRequest, res) => {
  const { turnoId } = req.params;
  await assertChatAccess(turnoId, req);

  const sinceRaw = typeof req.query.since === 'string' ? req.query.since : undefined;
  const since = sinceRaw ? new Date(sinceRaw) : undefined;
  const isValidSince = since !== undefined && !Number.isNaN(since.getTime());

  const mensajes = await prisma.chatMensaje.findMany({
    where: { turnoId, ...(isValidSince ? { createdAt: { gt: since } } : {}) },
    orderBy: { createdAt: 'asc' },
    take: 200,
  });

  // Mark unread messages from the other party as read
  const userId = req.user!.userId;
  const unreadIds = mensajes
    .filter(m => m.remitenteId !== userId && !m.leidoAt)
    .map(m => m.id);

  if (unreadIds.length > 0) {
    await prisma.chatMensaje.updateMany({
      where: { id: { in: unreadIds } },
      data: { leidoAt: new Date() },
    });
  }

  res.json(success(mensajes));
}));

// POST /api/chat/:turnoId — send a message
router.post(
  '/:turnoId',
  body('contenido').isString().trim().isLength({ min: 1, max: 2000 }),
  asyncHandler(async (req: AuthRequest, res) => {
    validateRequest(validationResult(req));

    const { turnoId } = req.params;
    const { contenido } = req.body;
    const { turno, isPaciente } = await assertChatAccess(turnoId, req, { forWrite: true });

    const userId = req.user!.userId;

    const mensaje = await prisma.chatMensaje.create({
      data: { turnoId, remitenteId: userId, contenido },
    });

    // Notify the other party
    const senderName = isPaciente
      ? `${turno.paciente!.nombre} ${turno.paciente!.apellido}`
      : `${turno.profesional.nombre} ${turno.profesional.apellido}`;
    const recipientUserId = isPaciente
      ? turno.profesional.usuarioId
      : turno.paciente?.usuarioId;

    if (recipientUserId) {
      const preview = contenido.length > 80 ? contenido.slice(0, 80) + '…' : contenido;
      createNotification({
        usuarioId: recipientUserId,
        tipo: 'CHAT_MENSAJE',
        titulo: `Mensaje de ${senderName}`,
        cuerpo: preview,
        link: `/dashboard`,
      }).catch(() => {});
    }

    res.status(201).json(success(mensaje));
  })
);

// GET /api/chat/:turnoId/unread — count of unread messages for current user
router.get('/:turnoId/unread', asyncHandler(async (req: AuthRequest, res) => {
  const { turnoId } = req.params;
  await assertChatAccess(turnoId, req);

  const userId = req.user!.userId;
  const count = await prisma.chatMensaje.count({
    where: { turnoId, remitenteId: { not: userId }, leidoAt: null },
  });

  res.json(success({ count }));
}));

export { router as chatRouter };



