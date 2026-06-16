import prisma from '../../lib/prisma';
import { AppError } from '../../utils/response';
import {
  NotificationPayload,
  resolveChannels,
  sendNotification,
} from '../../utils/notifications';
import { createNotification, CreateNotificationInput } from '../notification.service';

/**
 * Notification preferences carried on Paciente/Profesional records.
 */
export interface NotifPrefs {
  notifEmail: boolean;
  notifWhatsapp: boolean;
}

/**
 * Send the two notifications that every turno lifecycle event fires together:
 * the multi-channel (email/WhatsApp) delivery and the persisted in-app entry.
 *
 * Centralizes the `resolveChannels → sendNotification → createNotification`
 * sequence that was duplicated across reserve / reschedule / cancel / receta.
 * Pass `inApp: null` to send only the multi-channel delivery (e.g. for
 * account-less guests with no `usuario` to attach an in-app entry to).
 */
export async function notifyTurnoUser(
  prefs: NotifPrefs,
  send: NotificationPayload,
  inApp: CreateNotificationInput | null
): Promise<void> {
  await sendNotification(resolveChannels(prefs), send);
  if (inApp) {
    await createNotification(inApp);
  }
}

/**
 * Load a turno with the relations needed to authorize access and assert that
 * the requesting user is either its paciente or profesional. Throws 404/403.
 */
export async function assertTurnoAccess(turnoId: string, userId: string) {
  const turno = await prisma.turno.findUnique({
    where: { id: turnoId },
    include: {
      paciente: { select: { usuarioId: true } },
      profesional: { select: { usuarioId: true } },
      pago: true,
    },
  });

  if (!turno) {
    throw new AppError(404, 'NOT_FOUND', 'Turno no encontrado');
  }

  const isPacienteOwner = turno.paciente?.usuarioId === userId;
  const isProfesionalOwner = turno.profesional.usuarioId === userId;

  if (!isPacienteOwner && !isProfesionalOwner) {
    throw new AppError(403, 'FORBIDDEN', 'Sin permisos para acceder al turno');
  }

  return { turno, isPacienteOwner, isProfesionalOwner };
}

/**
 * Re-load a turno with the standard relations used in lifecycle responses.
 */
export function getTurnoStatusResponse(turnoId: string) {
  return prisma.turno.findUnique({
    where: { id: turnoId },
    include: {
      paciente: true,
      profesional: { include: { especialidad: true } },
    },
  });
}

/**
 * Whether `turnoFechaHora` is far enough in the future to respect the
 * cancellation/reschedule window (CANCELLATION_WINDOW_HOURS, default 24h).
 */
export function canCancelTurno(turnoFechaHora: Date): boolean {
  const cancellationWindowHours = Number(process.env.CANCELLATION_WINDOW_HOURS || 24);
  const diffMs = turnoFechaHora.getTime() - Date.now();
  return diffMs >= cancellationWindowHours * 60 * 60 * 1000;
}

export function createVideoCallLink(): string {
  return `https://meet.jit.si/MediSync-${Math.random().toString(36).substring(2, 10)}`;
}

export function assertPreconsultaEditable(turno: { fechaHora: Date; estado: string }) {
  if (!['RESERVADO', 'CONFIRMADO'].includes(turno.estado)) {
    throw new AppError(400, 'INVALID_STATE', 'Solo se puede completar preconsulta en turnos reservados o confirmados');
  }

  if (turno.fechaHora.getTime() <= Date.now()) {
    throw new AppError(422, 'APPOINTMENT_ALREADY_STARTED', 'La preconsulta solo se puede completar antes del turno');
  }
}
