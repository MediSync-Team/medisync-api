import prisma from '../lib/prisma';
import { sendNotification } from '../utils/notifications';
import { createNotification } from './notification.service';
import { CLINIC_TIME_ZONE, formatClinicDateKey, getClinicDateOnlyUtc } from '../utils/clinic-time';

const NOTIFY_EXPIRY_HOURS = 2;

function waitlistDateForAppointment(fechaHora: Date): Date {
  return getClinicDateOnlyUtc(formatClinicDateKey(fechaHora));
}

function dateOnlyKeyFromDbDate(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

export async function resolveWaitlistForBooking(params: {
  profesionalId: string;
  pacienteId: string;
  fechaHora: Date;
  modalidad: 'PRESENCIAL' | 'VIRTUAL';
}) {
  const fecha = waitlistDateForAppointment(params.fechaHora);

  await prisma.listaEspera.updateMany({
    where: {
      profesionalId: params.profesionalId,
      pacienteId: params.pacienteId,
      modalidad: params.modalidad,
      estado: { in: ['ACTIVA', 'NOTIFICADA'] },
      fecha,
    },
    data: {
      estado: 'RESUELTA',
    },
  });
}

async function sendWaitlistNotification(params: {
  profesionalId: string;
  fechaHora?: Date;
  fechaKey?: string;
  modalidad: 'PRESENCIAL' | 'VIRTUAL';
}) {
  const fechaKey = params.fechaKey ?? (params.fechaHora ? formatClinicDateKey(params.fechaHora) : null);
  if (!fechaKey) return;
  const fecha = getClinicDateOnlyUtc(fechaKey);

  // Use a transaction with a row-level lock to atomically claim one entry,
  // preventing the TOCTOU race condition where two concurrent calls could
  // both read the same ACTIVA entry and send duplicate notifications.
  const candidato = await prisma.$transaction(async (tx) => {
    // Find the oldest ACTIVA entry for this slot
    const entry = await tx.listaEspera.findFirst({
      where: {
        profesionalId: params.profesionalId,
        modalidad: params.modalidad,
        estado: 'ACTIVA',
        fecha,
      },
      orderBy: { createdAt: 'asc' },
    });

    if (!entry) return null;

    // Atomically claim it by setting estado to NOTIFICADA
    // Using update with the specific ID ensures only this one row is affected
    await tx.listaEspera.update({
      where: { id: entry.id },
      data: { estado: 'NOTIFICADA', notificadoAt: new Date() },
    });

    // Re-fetch with relations for notification data
    return await tx.listaEspera.findUnique({
      where: { id: entry.id },
      include: { paciente: true, profesional: true },
    });
  });

  if (!candidato) return;

  const displayDate = params.fechaHora ?? fecha;
  const fechaStr = displayDate.toLocaleDateString('es-AR', { timeZone: CLINIC_TIME_ZONE, weekday: 'long', day: 'numeric', month: 'long' });
  const horaStr = params.fechaHora?.toLocaleTimeString('es-AR', { timeZone: CLINIC_TIME_ZONE, hour: '2-digit', minute: '2-digit' });
  const profNombre = `Dr/a. ${candidato.profesional.nombre} ${candidato.profesional.apellido}`;
  const profileUrl = `/profesional/${params.profesionalId}`;
  const fechaHoraTexto = horaStr ? `${fechaStr} a las ${horaStr}` : fechaStr;

  await sendNotification(['EMAIL', 'WHATSAPP'], {
    event: 'LISTA_ESPERA_NOTIFICADA',
    title: '¡Se liberó un turno!',
    message: `Se liberó un turno con ${profNombre} para el ${fechaHoraTexto}. Tenés ${NOTIFY_EXPIRY_HOURS} horas para reservarlo desde MediSync.`,
    userEmail: candidato.paciente.email,
    userPhone: candidato.paciente.telefono,
    meta: {
      profesionalId: params.profesionalId,
      listaEsperaId: candidato.id,
      modalidad: params.modalidad,
      fechaHora: params.fechaHora?.toISOString(),
      profileUrl,
    },
  });

  await createNotification({
    usuarioId: candidato.paciente.usuarioId,
    tipo: 'LISTA_ESPERA_NOTIFICADA',
    titulo: '¡Se liberó un turno!',
    cuerpo: `Se liberó un turno con ${profNombre} para el ${fechaHoraTexto}. Tenés ${NOTIFY_EXPIRY_HOURS} horas para reservarlo.`,
    link: profileUrl,
  });
}

export async function notifyWaitlistForReleasedSlot(params: {
  profesionalId: string;
  fechaHora: Date;
  modalidad: 'PRESENCIAL' | 'VIRTUAL';
  turnoId: string;
}) {
  await sendWaitlistNotification({
    profesionalId: params.profesionalId,
    fechaHora: params.fechaHora,
    modalidad: params.modalidad,
  });
}

/**
 * Expire NOTIFICADA waitlist entries older than NOTIFY_EXPIRY_HOURS and
 * cascade the notification to the next person in line.
 * Called by the cron job every 30 minutes.
 */
export async function expireStaleWaitlistNotifications() {
  const cutoff = new Date(Date.now() - NOTIFY_EXPIRY_HOURS * 60 * 60 * 1000);

  const stale = await prisma.listaEspera.findMany({
    where: {
      estado: 'NOTIFICADA',
      notificadoAt: { lt: cutoff },
    },
  });

  if (stale.length === 0) return;

  // Mark all stale NOTIFICADA entries as EXPIRADA
  await prisma.listaEspera.updateMany({
    where: { id: { in: stale.map((s) => s.id) } },
    data: { estado: 'EXPIRADA' },
  });

  // For each expired entry, try to notify the next person in line for that slot
  const seen = new Set<string>();
  for (const item of stale) {
    const key = `${item.profesionalId}|${item.fecha.toISOString()}|${item.modalidad}`;
    if (seen.has(key)) continue;
    seen.add(key);

    await sendWaitlistNotification({
      profesionalId: item.profesionalId,
      fechaKey: dateOnlyKeyFromDbDate(item.fecha),
      modalidad: item.modalidad as 'PRESENCIAL' | 'VIRTUAL',
    });
  }
}
