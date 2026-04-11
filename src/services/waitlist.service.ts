import prisma from '../lib/prisma';
import { sendNotification } from '../utils/notifications';

function getUtcDayBounds(date: Date) {
  const start = new Date(date);
  start.setUTCHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);

  return { start, end };
}

export async function resolveWaitlistForBooking(params: {
  profesionalId: string;
  pacienteId: string;
  fechaHora: Date;
  modalidad: 'PRESENCIAL' | 'VIRTUAL';
}) {
  const { start, end } = getUtcDayBounds(params.fechaHora);

  await prisma.listaEspera.updateMany({
    where: {
      profesionalId: params.profesionalId,
      pacienteId: params.pacienteId,
      modalidad: params.modalidad,
      estado: 'ACTIVA',
      fecha: {
        gte: start,
        lt: end,
      },
    },
    data: {
      estado: 'RESUELTA',
    },
  });
}

export async function notifyWaitlistForReleasedSlot(params: {
  profesionalId: string;
  fechaHora: Date;
  modalidad: 'PRESENCIAL' | 'VIRTUAL';
  turnoId: string;
}) {
  const { start, end } = getUtcDayBounds(params.fechaHora);

  const candidato = await prisma.listaEspera.findFirst({
    where: {
      profesionalId: params.profesionalId,
      modalidad: params.modalidad,
      estado: 'ACTIVA',
      fecha: {
        gte: start,
        lt: end,
      },
    },
    include: {
      paciente: true,
    },
    orderBy: {
      createdAt: 'asc',
    },
  });

  if (!candidato) return;

  await prisma.listaEspera.update({
    where: { id: candidato.id },
    data: {
      estado: 'NOTIFICADA',
      notificadoAt: new Date(),
    },
  });

  await sendNotification(['EMAIL', 'WHATSAPP'], {
    title: 'Se libero un turno',
    message: `Se libero un turno para ${params.fechaHora.toLocaleDateString('es-AR')} a las ${params.fechaHora.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}. Reservalo desde MediSync antes de que se ocupe.`,
    userEmail: candidato.paciente.email,
    userPhone: candidato.paciente.telefono,
    meta: {
      turnoId: params.turnoId,
      profesionalId: params.profesionalId,
      listaEsperaId: candidato.id,
      modalidad: params.modalidad,
    },
  });
}
