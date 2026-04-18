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

// ── Paciente-side calendar sync ───────────────────────────────────────────────

function buildPacienteTitle(profNombre: string, especialidad: string, modalidad: string): string {
  return `Consulta con Dr/a. ${profNombre} — ${especialidad} (${modalidad === 'VIRTUAL' ? 'Virtual' : 'Presencial'})`;
}

function buildPacienteDescription(
  profNombre: string,
  especialidad: string,
  modalidad: string,
  linkVideollamada: string | null,
  lugarAtencion: string | null,
): string {
  const lines = [`Especialidad: ${especialidad}`, `Profesional: Dr/a. ${profNombre}`];
  if (modalidad === 'VIRTUAL' && linkVideollamada) {
    lines.push(`Videollamada: ${linkVideollamada}`);
  } else if (lugarAtencion) {
    lines.push(`Lugar: ${lugarAtencion}`);
  }
  lines.push('Gestionado por MediSync');
  return lines.join('\n');
}

/** Create a calendar event on the paciente's Google Calendar when a turno is reserved/confirmed. */
export async function syncTurnoCreatedForPaciente(turnoId: string): Promise<void> {
  try {
    const turno = await prisma.turno.findUnique({
      where: { id: turnoId },
      include: {
        profesional: { include: { especialidad: true } },
        paciente: { include: { usuario: true } },
      },
    });

    if (!turno?.paciente?.usuario?.googleToken) return;

    const profNombre = `${turno.profesional.nombre} ${turno.profesional.apellido}`;
    const endAt = endTime(turno.fechaHora, turno.duracionMin);

    const eventId = await createCalendarEvent(turno.paciente.usuario.googleToken, {
      turnoId,
      title:        buildPacienteTitle(profNombre, turno.profesional.especialidad.nombre, turno.modalidad),
      description:  buildPacienteDescription(profNombre, turno.profesional.especialidad.nombre, turno.modalidad, turno.linkVideollamada, turno.profesional.lugarAtencion),
      startIso:     turno.fechaHora.toISOString(),
      endIso:       endAt.toISOString(),
      location:     turno.modalidad === 'PRESENCIAL' ? (turno.profesional.lugarAtencion ?? undefined) : undefined,
    });

    // Store in a dedicated column to avoid collision with the profesional's event id
    await prisma.turno.update({
      where: { id: turnoId },
      data:  { googleEventIdPaciente: eventId },
    });
  } catch (err) {
    console.error('[CalendarSync] syncTurnoCreatedForPaciente failed:', err);
  }
}

/** Update the paciente's calendar event when a turno is rescheduled. */
export async function syncTurnoRescheduledForPaciente(turnoId: string): Promise<void> {
  try {
    const turno = await prisma.turno.findUnique({
      where: { id: turnoId },
      include: {
        profesional: { include: { especialidad: true } },
        paciente: { include: { usuario: true } },
      },
    });

    if (!turno?.paciente?.usuario?.googleToken) return;

    if (!turno.googleEventIdPaciente) {
      await syncTurnoCreatedForPaciente(turnoId);
      return;
    }

    const profNombre = `${turno.profesional.nombre} ${turno.profesional.apellido}`;
    const endAt = endTime(turno.fechaHora, turno.duracionMin);

    await updateCalendarEvent(turno.paciente.usuario.googleToken, turno.googleEventIdPaciente, {
      title:        buildPacienteTitle(profNombre, turno.profesional.especialidad.nombre, turno.modalidad),
      description:  buildPacienteDescription(profNombre, turno.profesional.especialidad.nombre, turno.modalidad, turno.linkVideollamada, turno.profesional.lugarAtencion),
      startIso:     turno.fechaHora.toISOString(),
      endIso:       endAt.toISOString(),
      location:     turno.modalidad === 'PRESENCIAL' ? (turno.profesional.lugarAtencion ?? undefined) : undefined,
    });
  } catch (err) {
    console.error('[CalendarSync] syncTurnoRescheduledForPaciente failed:', err);
  }
}

/** Delete the paciente's calendar event when a turno is cancelled. */
export async function syncTurnoCancelledForPaciente(turnoId: string): Promise<void> {
  try {
    const turno = await prisma.turno.findUnique({
      where: { id: turnoId },
      include: { paciente: { include: { usuario: true } } },
    });

    if (!turno?.paciente?.usuario?.googleToken || !turno.googleEventIdPaciente) return;

    await deleteCalendarEvent(turno.paciente.usuario.googleToken, turno.googleEventIdPaciente);

    await prisma.turno.update({
      where: { id: turnoId },
      data:  { googleEventIdPaciente: null },
    });
  } catch (err) {
    console.error('[CalendarSync] syncTurnoCancelledForPaciente failed:', err);
  }
}
