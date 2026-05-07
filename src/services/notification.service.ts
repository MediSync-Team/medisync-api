import { Response } from 'express';
import prisma from '../lib/prisma';
import { sendWebPush } from './web-push.service';

// ── SSE connection registry ──────────────────────────────────────────────────
// Maps userId → array of open SSE Response objects (a user can have multiple tabs)
const sseClients = new Map<string, Response[]>();

export function addSseClient(userId: string, res: Response) {
  const existing = sseClients.get(userId) ?? [];
  existing.push(res);
  sseClients.set(userId, existing);
}

export function removeSseClient(userId: string, res: Response) {
  const existing = sseClients.get(userId) ?? [];
  const updated = existing.filter(r => r !== res);
  if (updated.length === 0) {
    sseClients.delete(userId);
  } else {
    sseClients.set(userId, updated);
  }
}

function pushToUser(userId: string, data: object) {
  const clients = sseClients.get(userId);
  if (!clients || clients.length === 0) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      // client disconnected mid-write — will be cleaned up on close
    }
  }
}

// ── Core helper ──────────────────────────────────────────────────────────────

export interface CreateNotificationInput {
  usuarioId: string;
  tipo: string;
  titulo: string;
  cuerpo: string;
  link?: string;
}

// Maps notification tipo → Usuario push preference column
const PUSH_PREF_MAP: Record<string, 'pushTurno' | 'pushCancelacion' | 'pushRecordatorio' | 'pushReceta' | 'pushChat'> = {
  TURNO_RESERVADO:    'pushTurno',
  TURNO_CONFIRMADO:   'pushTurno',
  TURNO_REPROGRAMADO: 'pushTurno',
  TURNO_CANCELADO:    'pushCancelacion',
  RECORDATORIO_24H:   'pushRecordatorio',
  RECORDATORIO_2H:    'pushRecordatorio',
  RECETA_EMITIDA:     'pushReceta',
  CHAT_MENSAJE:       'pushChat',
};

export async function createNotification(input: CreateNotificationInput) {
  const notif = await prisma.notificacion.create({
    data: {
      usuarioId: input.usuarioId,
      tipo:      input.tipo,
      titulo:    input.titulo,
      cuerpo:    input.cuerpo,
      link:      input.link,
    },
  });

  // Push real-time to connected SSE clients
  pushToUser(input.usuarioId, {
    id:        notif.id,
    tipo:      notif.tipo,
    titulo:    notif.titulo,
    cuerpo:    notif.cuerpo,
    leida:     notif.leida,
    link:      notif.link,
    createdAt: notif.createdAt,
  });

  // Web Push — only if user has this event type enabled
  const prefKey = PUSH_PREF_MAP[input.tipo];
  const shouldPush = await (async () => {
    if (!prefKey) return true; // unknown types always push
    const usuario = await prisma.usuario.findUnique({
      where: { id: input.usuarioId },
      select: { [prefKey]: true },
    });
    return usuario ? (usuario as any)[prefKey] !== false : true;
  })();

  if (shouldPush) {
    sendWebPush(input.usuarioId, {
      title: input.titulo,
      body:  input.cuerpo,
      tag:   input.tipo,
      url:   input.link ?? '/',
    }).catch((err) => console.error('[web-push] fire-and-forget error:', err));
  }

  return notif;
}
