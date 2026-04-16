import prisma from '../lib/prisma';
import { sendNotification, resolveChannels } from '../utils/notifications';

async function sendReminders(windowLabel: '24h' | '2h') {
  const now = new Date();

  const windowMs = windowLabel === '24h'
    ? 24 * 60 * 60 * 1000
    : 2 * 60 * 60 * 1000;

  // Tolerancia de ±5 min para evitar duplicados entre ejecuciones del cron
  const windowStart = new Date(now.getTime() + windowMs - 5 * 60 * 1000);
  const windowEnd   = new Date(now.getTime() + windowMs + 5 * 60 * 1000);

  const preferenceField = windowLabel === '24h'
    ? 'notifRecordatorio24h'
    : 'notifRecordatorio2h';

  const turnos = await prisma.turno.findMany({
    where: {
      fechaHora: { gte: windowStart, lte: windowEnd },
      estado: { in: ['RESERVADO', 'CONFIRMADO'] },
      paciente: {
        aceptaRecordatorios: true,
        [preferenceField]: true,
      },
    },
    include: {
      paciente: true,
      profesional: { include: { especialidad: true } },
    },
    take: 200,
  });

  const label = windowLabel === '24h' ? '24 horas' : '2 horas';

  await Promise.allSettled(
    turnos.map(async (turno) => {
      if (!turno.paciente) return;

      const channels = resolveChannels({
        notifEmail: turno.paciente.notifEmail,
        notifWhatsapp: turno.paciente.notifWhatsapp,
      });

      await sendNotification(channels, {
        event: windowLabel === '24h' ? 'RECORDATORIO_24H' : 'RECORDATORIO_2H',
        title: `Recordatorio: turno en ${label}`,
        message: `Tenés un turno en ${label} con ${turno.profesional.nombre} ${turno.profesional.apellido}.`,
        userEmail: turno.paciente.email,
        userPhone: turno.paciente.telefono ?? undefined,
        meta: {
          turnoId: turno.id,
          fechaHora: turno.fechaHora.toISOString(),
          profesional: `Dr/a. ${turno.profesional.nombre} ${turno.profesional.apellido}`,
          especialidad: turno.profesional.especialidad.nombre,
          modalidad: turno.modalidad,
          lugarAtencion: turno.profesional.lugarAtencion ?? undefined,
          linkVideollamada: turno.linkVideollamada ?? undefined,
        },
      });
    }),
  );

  console.log(`[reminders:${windowLabel}] processed ${turnos.length} appointment(s)`);
}

/** Corre cada hora — envía recordatorios de 24 h y 2 h */
export async function sendUpcomingAppointmentsReminders() {
  await Promise.allSettled([
    sendReminders('24h'),
    sendReminders('2h'),
  ]);
}
