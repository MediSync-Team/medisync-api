import prisma from '../lib/prisma';
import { sendNotification, resolveChannels } from '../utils/notifications';
import { createNotification } from './notification.service';
import { prepareWhatsappReminderSession } from './whatsapp.service';

async function sendReminders(windowLabel: '48h' | '24h' | '2h') {
  const now = new Date();

  const windowMs = windowLabel === '48h'
    ? 48 * 60 * 60 * 1000
    : windowLabel === '24h'
      ? 24 * 60 * 60 * 1000
      : 2 * 60 * 60 * 1000;

  // ±35 min window so every 30-min cron run covers all turnos without gaps
  const windowStart = new Date(now.getTime() + windowMs - 35 * 60 * 1000);
  const windowEnd   = new Date(now.getTime() + windowMs + 35 * 60 * 1000);

  const preferenceField = windowLabel === '48h' || windowLabel === '24h'
    ? 'notifRecordatorio24h'
    : 'notifRecordatorio2h';

  const turnos = await prisma.turno.findMany({
    where: {
      fechaHora: { gte: windowStart, lte: windowEnd },
      estado: { in: ['RESERVADO', 'CONFIRMADO'] },
    },
    include: {
      paciente: { include: { usuario: { select: { id: true } } } },
      profesional: {
        include: {
          especialidad: true,
          usuario: { select: { id: true } },
        },
      },
    },
    take: 500,
  });

  const label = windowLabel === '48h' ? '48 horas' : windowLabel === '24h' ? '24 horas' : '2 horas';
  const eventKey = windowLabel === '48h' ? 'RECORDATORIO_48H' : windowLabel === '24h' ? 'RECORDATORIO_24H' : 'RECORDATORIO_2H';

  await Promise.allSettled(
    turnos.flatMap((turno) => {
      const tasks: Promise<unknown>[] = [];

      // ── Paciente ─────────────────────────────────────────────────────────
      if (
        turno.paciente?.aceptaRecordatorios &&
        (turno.paciente as Record<string, unknown>)[preferenceField] &&
        (windowLabel !== '48h' || (turno.paciente.notifWhatsapp && turno.paciente.telefono))
      ) {
        const tipoKey = `${windowLabel}_paciente` as const;

        tasks.push(
          prisma.recordatorioEnviado
            .create({ data: { turnoId: turno.id, tipo: tipoKey } })
            .then(async () => {
              const paciente = turno.paciente!;
              if (windowLabel === '48h' && paciente.telefono) {
                await prepareWhatsappReminderSession({
                  phone: paciente.telefono,
                  pacienteId: paciente.id,
                  turnoId: turno.id,
                });
              }

              const channels = resolveChannels({
                notifEmail: windowLabel === '48h' ? false : paciente.notifEmail,
                notifWhatsapp: paciente.notifWhatsapp,
              });

              await sendNotification(channels, {
                event: eventKey,
                title: `Recordatorio: turno en ${label}`,
                message: `Tenés un turno en ${label} con ${turno.profesional.nombre} ${turno.profesional.apellido}.`,
                userEmail: paciente.email,
                userPhone: paciente.telefono ?? undefined,
                meta: {
                  turnoId: turno.id,
                  fechaHora: turno.fechaHora.toISOString(),
                  profesional: `Dr/a. ${turno.profesional.nombre} ${turno.profesional.apellido}`,
                  fechaTexto: turno.fechaHora.toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }),
                  especialidad: turno.profesional.especialidad.nombre,
                  modalidad: turno.modalidad,
                  lugarAtencion: turno.profesional.lugarAtencion ?? undefined,
                  linkVideollamada: turno.linkVideollamada ?? undefined,
                },
              });

              // In-app notification
              if (paciente.usuario?.id) {
                await createNotification({
                  usuarioId: paciente.usuario.id,
                  tipo: eventKey,
                  titulo: `Turno en ${label}`,
                  cuerpo: `Tu turno con ${turno.profesional.nombre} ${turno.profesional.apellido} es en ${label}.`,
                  link: '/dashboard/paciente',
                });
              }
            })
            .catch((err: { code?: string }) => {
              // P2002 = unique constraint violation → already sent
              if (err?.code !== 'P2002') {
                console.error(`[reminders] paciente ${tipoKey} turno ${turno.id}:`, err);
              }
            }),
        );
      }

      if (windowLabel === '48h') {
        return tasks;
      }

      // ── Profesional ───────────────────────────────────────────────────────
      if (turno.profesional.notifEmail || turno.profesional.notifWhatsapp) {
        const tipoKey = `${windowLabel}_profesional` as const;

        tasks.push(
          prisma.recordatorioEnviado
            .create({ data: { turnoId: turno.id, tipo: tipoKey } })
            .then(async () => {
              const prof = turno.profesional;
              const profUsuario = await prisma.usuario.findUnique({
                where: { id: prof.usuarioId },
                select: { email: true },
              });

              const channels = resolveChannels({
                notifEmail: prof.notifEmail,
                notifWhatsapp: prof.notifWhatsapp,
              });

              const pacienteNombre = turno.paciente
                ? `${turno.paciente.nombre} ${turno.paciente.apellido}`
                : 'un paciente';

              await sendNotification(channels, {
                event: eventKey,
                title: `Recordatorio: turno en ${label}`,
                message: `Tenés un turno con ${pacienteNombre} en ${label}.`,
                userEmail: profUsuario?.email ?? '',
                userPhone: prof.telefono ?? undefined,
                meta: {
                  turnoId: turno.id,
                  fechaHora: turno.fechaHora.toISOString(),
                  paciente: pacienteNombre,
                  modalidad: turno.modalidad,
                  lugarAtencion: prof.lugarAtencion ?? undefined,
                  linkVideollamada: turno.linkVideollamada ?? undefined,
                },
              });

              // In-app notification
              if (prof.usuario?.id) {
                await createNotification({
                  usuarioId: prof.usuario.id,
                  tipo: eventKey,
                  titulo: `Turno en ${label}`,
                  cuerpo: `Tu turno con ${pacienteNombre} es en ${label}.`,
                  link: '/dashboard',
                });
              }
            })
            .catch((err: { code?: string }) => {
              if (err?.code !== 'P2002') {
                console.error(`[reminders] profesional ${tipoKey} turno ${turno.id}:`, err);
              }
            }),
        );
      }

      return tasks;
    }),
  );

  console.log(`[reminders:${windowLabel}] processed ${turnos.length} appointment(s)`);
}

/** Runs every 30 min — sends 48h, 24h and 2h reminders */
export async function sendUpcomingAppointmentsReminders() {
  await Promise.allSettled([
    sendReminders('48h'),
    sendReminders('24h'),
    sendReminders('2h'),
  ]);
}
