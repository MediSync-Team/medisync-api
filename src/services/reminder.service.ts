import prisma from '../lib/prisma';
import { sendNotification } from '../utils/notifications';

export async function sendUpcomingAppointmentsReminders() {
  const now = new Date();
  const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  const turnos = await prisma.turno.findMany({
    where: {
      fechaHora: {
        gte: now,
        lte: in24h,
      },
      estado: { in: ['RESERVADO', 'CONFIRMADO'] },
    },
    include: {
      paciente: true,
      profesional: true,
    },
    take: 100,
  });

  await Promise.all(
    turnos
      .filter((turno) => turno.paciente?.aceptaRecordatorios)
      .map((turno) =>
        sendNotification(['EMAIL', 'WHATSAPP'], {
          title: 'Recordatorio de turno',
          message: `Recordatorio: tenes un turno el ${turno.fechaHora.toLocaleString('es-AR')} con ${turno.profesional.nombre} ${turno.profesional.apellido}.`,
          userEmail: turno.paciente?.email,
          userPhone: turno.paciente?.telefono,
          meta: {
            turnoId: turno.id,
            profesionalId: turno.profesionalId,
          },
        })
      )
  );
}
