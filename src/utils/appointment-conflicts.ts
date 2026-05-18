export const DEFAULT_APPOINTMENT_DURATION_MIN = 30;

export type AppointmentConflictCandidate = {
  fechaHora: Date;
  duracionMin?: number | null;
  estado?: string | null;
};

export function getAppointmentEnd(fechaHora: Date, duracionMin: number = DEFAULT_APPOINTMENT_DURATION_MIN): Date {
  return new Date(fechaHora.getTime() + duracionMin * 60_000);
}

export function intervalsOverlap(startA: Date, endA: Date, startB: Date, endB: Date): boolean {
  return startA < endB && endA > startB;
}

export function appointmentOverlapsSlot(
  appointment: AppointmentConflictCandidate,
  slotStart: Date,
  slotDurationMin: number = DEFAULT_APPOINTMENT_DURATION_MIN
): boolean {
  if (appointment.estado === 'CANCELADO') return false;

  const slotEnd = getAppointmentEnd(slotStart, slotDurationMin);
  const appointmentEnd = getAppointmentEnd(
    appointment.fechaHora,
    appointment.duracionMin ?? DEFAULT_APPOINTMENT_DURATION_MIN
  );

  return intervalsOverlap(slotStart, slotEnd, appointment.fechaHora, appointmentEnd);
}

export function hasAppointmentConflict(
  appointments: AppointmentConflictCandidate[],
  slotStart: Date,
  slotDurationMin: number = DEFAULT_APPOINTMENT_DURATION_MIN
): boolean {
  return appointments.some((appointment) => appointmentOverlapsSlot(appointment, slotStart, slotDurationMin));
}
