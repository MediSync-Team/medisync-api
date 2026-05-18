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
async function assertChatAccess(turnoId: string, req: AuthRequest) {
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

  if (turno.estado === 'CANCELADO') {
    throw new AppError(400, 'TURNO_CANCELADO', 'No se puede chatear en un turno cancelado');
  }

  return { turno, isPaciente, isProfesional };
}

// GET /api/chat/:turnoId — list messages
router.get('/:turnoId', asyncHandler(async (req: AuthRequest, res) => {
  const { turnoId } = req.params;
  await assertChatAccess(turnoId, req);

  const mensajes = await prisma.chatMensaje.findMany({
    where: { turnoId },
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
    const { turno, isPaciente } = await assertChatAccess(turnoId, req);

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



