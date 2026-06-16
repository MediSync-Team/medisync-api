import { Modalidad } from '@prisma/client';
import prisma from '../../lib/prisma';
import { AppError } from '../../utils/response';
import {
  DEFAULT_APPOINTMENT_DURATION_MIN,
  findMatchingAvailability,
  hasAppointmentConflict,
  hasBlockConflict,
} from '../../utils/appointment-conflicts';
import { acquireAppointmentDayLock } from '../../utils/appointment-locks';
import {
  formatClinicDateTimeEs,
  getClinicDateTimeParts,
  getClinicDateOnlyUtc,
  getClinicDayBoundsForInstant,
} from '../../utils/clinic-time';
import {
  assertTurnoAccess,
  canCancelTurno,
  createVideoCallLink,
  notifyTurnoUser,
} from './turno-helpers';

export interface ReprogramarTurnoInput {
  turnoId: string;
  userId: string;
  fechaHora: unknown;
  modalidad?: string;
}

/**
 * Reschedule an existing turno to a new slot.
 *
 * Patients must respect the cancellation/reschedule window; professionals may
 * reschedule any time. Re-validates availability, block-outs and conflicts
 * under an advisory lock, then notifies the affected parties. Returns the
 * updated turno; Google Calendar sync is left to the caller (post-response).
 */
export async function reprogramarTurno(input: ReprogramarTurnoInput) {
  const { turnoId, userId, fechaHora, modalidad } = input;

  if (!fechaHora) {
    throw new AppError(400, 'VALIDATION_ERROR', 'fechaHora es requerida');
  }

  const nuevaFechaHora = new Date(String(fechaHora));
  if (Number.isNaN(nuevaFechaHora.getTime()) || nuevaFechaHora <= new Date()) {
    throw new AppError(400, 'VALIDATION_ERROR', 'La nueva fecha debe ser futura y valida');
  }

  const nuevaClinicParts = getClinicDateTimeParts(nuevaFechaHora);

  if (nuevaClinicParts.minute !== 0 && nuevaClinicParts.minute !== 30) {
    throw new AppError(400, 'VALIDATION_ERROR', 'El horario debe ser en bloques de 30 minutos');
  }

  const nuevaModalidad = modalidad || undefined;
  if (nuevaModalidad && !['PRESENCIAL', 'VIRTUAL'].includes(nuevaModalidad)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Modalidad invalida');
  }

  const { turno, isPacienteOwner, isProfesionalOwner } = await assertTurnoAccess(turnoId, userId);

  if (!isPacienteOwner && !isProfesionalOwner) {
    throw new AppError(403, 'FORBIDDEN', 'Sin permisos para reprogramar este turno');
  }

  if (!['RESERVADO', 'CONFIRMADO'].includes(turno.estado)) {
    throw new AppError(400, 'INVALID_STATE', 'Solo se pueden reprogramar turnos reservados o confirmados');
  }

  // Pacientes deben respetar la ventana de cancelación; profesionales pueden reprogramar sin restricción de tiempo
  if (isPacienteOwner && !canCancelTurno(turno.fechaHora)) {
    throw new AppError(
      422,
      'RESCHEDULE_WINDOW_EXCEEDED',
      `Solo podes reprogramar turnos con al menos ${process.env.CANCELLATION_WINDOW_HOURS || 24} horas de anticipacion`
    );
  }

  const modalidadFinal = nuevaModalidad || turno.modalidad;
  const diaSemana = nuevaClinicParts.weekday;
  const reprogramStartMinutes = nuevaClinicParts.hour * 60 + nuevaClinicParts.minute;
  const reprogramDurationMin = turno.duracionMin ?? DEFAULT_APPOINTMENT_DURATION_MIN;

  const disponibilidades = await prisma.disponibilidad.findMany({
    where: { profesionalId: turno.profesionalId, diaSemana, activo: true },
  });

  const matchingDispRep = findMatchingAvailability(disponibilidades, modalidadFinal, reprogramStartMinutes, reprogramDurationMin);

  if (!matchingDispRep) {
    throw new AppError(409, 'HORARIO_NO_DISPONIBLE', 'El horario seleccionado no esta disponible para este profesional');
  }

  const profReprog = await prisma.profesional.findUnique({ where: { id: turno.profesionalId }, select: { lugarAtencion: true } });
  const nuevaLinkVideollamada = modalidadFinal === 'VIRTUAL'
    ? turno.linkVideollamada ?? createVideoCallLink()
    : null;
  const nuevaLugarAtencion = modalidadFinal === 'PRESENCIAL'
    ? matchingDispRep?.lugarAtencion ?? profReprog?.lugarAtencion ?? null
    : null;

  const nuevaSlotDate = getClinicDateOnlyUtc(nuevaClinicParts.dateKey);
  const bloqueosReprogramacion = await prisma.bloqueoDisponibilidad.findMany({
    where: {
      profesionalId: turno.profesionalId,
      fechaInicio: { lte: nuevaSlotDate },
      fechaFin: { gte: nuevaSlotDate },
    },
  });
  const nuevaSlotMinutes = nuevaClinicParts.hour * 60 + nuevaClinicParts.minute;
  if (hasBlockConflict(bloqueosReprogramacion, nuevaSlotMinutes, reprogramDurationMin)) {
    throw new AppError(409, 'HORARIO_BLOQUEADO', 'El profesional no está disponible en ese horario');
  }

  const turnoActualizado = await prisma.$transaction(async (tx) => {
    await acquireAppointmentDayLock(tx, turno.profesionalId, nuevaClinicParts.dateKey);

    const { start, end } = getClinicDayBoundsForInstant(nuevaFechaHora);
    const turnosDelDia = await tx.turno.findMany({
      where: {
        id: { not: turno.id },
        profesionalId: turno.profesionalId,
        fechaHora: { gte: start, lt: end },
        estado: { notIn: ['CANCELADO'] },
      },
      select: { fechaHora: true, duracionMin: true, estado: true },
    });

    if (hasAppointmentConflict(turnosDelDia, nuevaFechaHora, reprogramDurationMin)) {
      throw new AppError(409, 'HORARIO_NO_DISPONIBLE', 'El nuevo horario ya fue reservado');
    }

    return tx.turno.update({
      where: { id: turno.id },
      data: {
        fechaHora: nuevaFechaHora,
        modalidad: modalidadFinal as Modalidad,
        linkVideollamada: nuevaLinkVideollamada,
        lugarAtencion: nuevaLugarAtencion,
        estado: turno.pago?.estado === 'APROBADO' ? 'CONFIRMADO' : 'RESERVADO',
      },
      include: {
        paciente: { include: { usuario: { select: { id: true } } } },
        profesional: true,
        pago: true,
      },
    });
  });

  // Notificar al paciente
  if (turnoActualizado.paciente) {
    const pac = turnoActualizado.paciente;
    const who = isProfesionalOwner
      ? `Dr/a. ${turnoActualizado.profesional.nombre} ${turnoActualizado.profesional.apellido}`
      : 'vos';
    await notifyTurnoUser(
      { notifEmail: pac.notifEmail, notifWhatsapp: pac.notifWhatsapp },
      {
        event: 'TURNO_REPROGRAMADO',
        title: 'Turno reprogramado',
        message: `Tu turno con ${turnoActualizado.profesional.nombre} ${turnoActualizado.profesional.apellido} fue reprogramado para el ${formatClinicDateTimeEs(nuevaFechaHora)}.`,
        userEmail: pac.email,
        userPhone: pac.telefono ?? undefined,
        meta: {
          turnoId: turnoActualizado.id,
          fechaHora: turnoActualizado.fechaHora.toISOString(),
          profesional: `Dr/a. ${turnoActualizado.profesional.nombre} ${turnoActualizado.profesional.apellido}`,
          modalidad: turnoActualizado.modalidad,
          lugarAtencion: turnoActualizado.lugarAtencion ?? turnoActualizado.profesional.lugarAtencion ?? undefined,
          linkVideollamada: turnoActualizado.linkVideollamada ?? undefined,
        },
      },
      // In-app notification only when the paciente has a usuario account.
      pac.usuario?.id
        ? {
            usuarioId: pac.usuario.id,
            tipo: 'TURNO_REPROGRAMADO',
            titulo: 'Turno reprogramado',
            cuerpo: `${who} reprogramó tu turno con Dr/a. ${turnoActualizado.profesional.nombre} ${turnoActualizado.profesional.apellido} para el ${formatClinicDateTimeEs(nuevaFechaHora)}.`,
            link: '/dashboard/paciente',
          }
        : null
    );
  }

  // Si lo reprogramó el paciente, notificar también al profesional
  if (isPacienteOwner) {
    const profUsuario = await prisma.usuario.findUnique({ where: { id: turnoActualizado.profesional.usuarioId } });
    const pacNombre = turnoActualizado.paciente
      ? `${turnoActualizado.paciente.nombre} ${turnoActualizado.paciente.apellido}`
      : 'El paciente';
    await notifyTurnoUser(
      {
        notifEmail: turnoActualizado.profesional.notifEmail,
        notifWhatsapp: turnoActualizado.profesional.notifWhatsapp,
      },
      {
        event: 'TURNO_REPROGRAMADO',
        title: 'Turno reprogramado por el paciente',
        message: `${pacNombre} reprogramó su turno para el ${formatClinicDateTimeEs(nuevaFechaHora)}.`,
        userEmail: profUsuario?.email,
        userPhone: turnoActualizado.profesional.telefono || undefined,
        meta: {
          turnoId: turnoActualizado.id,
          fechaHora: turnoActualizado.fechaHora.toISOString(),
          paciente: pacNombre,
          modalidad: turnoActualizado.modalidad,
        },
      },
      {
        usuarioId: turnoActualizado.profesional.usuarioId,
        tipo: 'TURNO_REPROGRAMADO',
        titulo: 'Turno reprogramado',
        cuerpo: `${pacNombre} reprogramó su turno para el ${formatClinicDateTimeEs(nuevaFechaHora)}.`,
        link: '/dashboard',
      }
    );
  }

  return turnoActualizado;
}
