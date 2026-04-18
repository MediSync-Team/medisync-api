/**
 * calendar-sync.service.ts
 *
 * Fire-and-forget helpers that sync a Turno with the profesional's Google Calendar.
 * Every function is safe to call unconditionally — it silently no-ops when the
 * profesional hasn't connected Google Calendar.
 */
import prisma from '../lib/prisma';
import {
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
} from './google-calendar.service';

function endTime(fechaHora: Date, duracionMin: number): Date {
  return new Date(fechaHora.getTime() + duracionMin * 60_000);
}

function buildTitle(
  pacienteNombre: string,
  especialidad: string,
  modalidad: string,
): string {
  return `Consulta ${especialidad} — ${pacienteNombre} (${modalidad === 'VIRTUAL' ? 'Virtual' : 'Presencial'})`;
}

function buildDescription(
  pacienteNombre: string,
  modalidad: string,
  linkVideollamada: string | null,
  lugarAtencion: string | null,
): string {
  const lines = [`Paciente: ${pacienteNombre}`];
  if (modalidad === 'VIRTUAL' && linkVideollamada) {
    lines.push(`Videollamada: ${linkVideollamada}`);
  } else if (lugarAtencion) {
    lines.push(`Lugar: ${lugarAtencion}`);
  }
  lines.push('Gestionado por MediSync');
  return lines.join('\n');
}

/** Called after a turno is created. Creates the calendar event and stores its ID. */
export async function syncTurnoCreated(turnoId: string): Promise<void> {
  try {
    const turno = await prisma.turno.findUnique({
      where: { id: turnoId },
      include: {
        profesional: { include: { especialidad: true, usuario: true } },
        paciente: true,
      },
    });

    if (!turno || !turno.profesional.usuario.googleToken) return;

    const pacNombre = turno.paciente
      ? `${turno.paciente.nombre} ${turno.paciente.apellido}`
      : 'Paciente sin cuenta';

    const endAt = endTime(turno.fechaHora, turno.duracionMin);

    const eventId = await createCalendarEvent(
      turno.profesional.usuario.googleToken,
      {
        turnoId,
        title:       buildTitle(pacNombre, turno.profesional.especialidad.nombre, turno.modalidad),
        description: buildDescription(pacNombre, turno.modalidad, turno.linkVideollamada, turno.profesional.lugarAtencion),
        startIso:    turno.fechaHora.toISOString(),
        endIso:      endAt.toISOString(),
        location:    turno.profesional.lugarAtencion ?? undefined,
        attendeeEmail: turno.paciente?.email ?? undefined,
      },
    );

    await prisma.turno.update({
      where: { id: turnoId },
      data:  { googleEventId: eventId },
    });
  } catch (err) {
    console.error('[CalendarSync] syncTurnoCreated failed:', err);
  }
}

/** Called after a turno is rescheduled. Updates the calendar event times. */
export async function syncTurnoRescheduled(turnoId: string): Promise<void> {
  try {
    const turno = await prisma.turno.findUnique({
      where: { id: turnoId },
      include: {
        profesional: { include: { especialidad: true, usuario: true } },
        paciente: true,
      },
    });

    if (!turno || !turno.profesional.usuario.googleToken || !turno.googleEventId) {
      // No event to update — try to create one instead
      if (turno?.profesional.usuario.googleToken) await syncTurnoCreated(turnoId);
      return;
    }

    const pacNombre = turno.paciente
      ? `${turno.paciente.nombre} ${turno.paciente.apellido}`
      : 'Paciente sin cuenta';

    const endAt = endTime(turno.fechaHora, turno.duracionMin);

    await updateCalendarEvent(
      turno.profesional.usuario.googleToken,
      turno.googleEventId,
      {
        title:       buildTitle(pacNombre, turno.profesional.especialidad.nombre, turno.modalidad),
        description: buildDescription(pacNombre, turno.modalidad, turno.linkVideollamada, turno.profesional.lugarAtencion),
        startIso:    turno.fechaHora.toISOString(),
        endIso:      endAt.toISOString(),
        location:    turno.profesional.lugarAtencion ?? undefined,
      },
    );
  } catch (err) {
    console.error('[CalendarSync] syncTurnoRescheduled failed:', err);
  }
}

/** Called when a turno is cancelled. Deletes the calendar event. */
export async function syncTurnoCancelled(turnoId: string): Promise<void> {
  try {
    const turno = await prisma.turno.findUnique({
      where: { id: turnoId },
      include: { profesional: { include: { usuario: true } } },
    });

    if (!turno || !turno.profesional.usuario.googleToken || !turno.googleEventId) return;

    await deleteCalendarEvent(turno.profesional.usuario.googleToken, turno.googleEventId);

    await prisma.turno.update({
      where: { id: turnoId },
      data:  { googleEventId: null },
    });
  } catch (err) {
    console.error('[CalendarSync] syncTurnoCancelled failed:', err);
  }
}
