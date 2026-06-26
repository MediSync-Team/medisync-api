export const DEFAULT_APPOINTMENT_DURATION_MIN = 30;

/** Grid step (minutes) for offering bookable start times. */
export const SLOT_GRID_STEP_MIN = 15;

export type AppointmentConflictCandidate = {
  fechaHora: Date;
  duracionMin?: number | null;
  estado?: string | null;
};

export type AvailabilityBlockCandidate = {
  horaInicio?: string | null;
  horaFin?: string | null;
};

export type AvailabilityCandidate = {
  horaInicio: string;
  horaFin: string;
  modalidad?: string | null;
};

export function getAppointmentEnd(fechaHora: Date, duracionMin: number = DEFAULT_APPOINTMENT_DURATION_MIN): Date {
  return new Date(fechaHora.getTime() + duracionMin * 60_000);
}

export function intervalsOverlap(startA: Date, endA: Date, startB: Date, endB: Date): boolean {
  return startA < endB && endA > startB;
}

export function timeStringToMinutes(value: string): number {
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

export function appointmentFitsAvailability(
  availability: AvailabilityCandidate,
  appointmentStartMinutes: number,
  appointmentDurationMin: number = DEFAULT_APPOINTMENT_DURATION_MIN
): boolean {
  const availabilityStartMinutes = timeStringToMinutes(availability.horaInicio);
  const availabilityEndMinutes = timeStringToMinutes(availability.horaFin);
  const appointmentEndMinutes = appointmentStartMinutes + appointmentDurationMin;

  return appointmentStartMinutes >= availabilityStartMinutes && appointmentEndMinutes <= availabilityEndMinutes;
}

export function findMatchingAvailability<T extends AvailabilityCandidate>(
  availabilities: T[],
  modalidad: string,
  appointmentStartMinutes: number,
  appointmentDurationMin: number = DEFAULT_APPOINTMENT_DURATION_MIN
): T | undefined {
  return availabilities.find((availability) => {
    const modalidadOk = availability.modalidad === 'AMBOS' || availability.modalidad === modalidad;
    return modalidadOk && appointmentFitsAvailability(availability, appointmentStartMinutes, appointmentDurationMin);
  });
}

export function appointmentOverlapsBlock(
  block: AvailabilityBlockCandidate,
  appointmentStartMinutes: number,
  appointmentDurationMin: number = DEFAULT_APPOINTMENT_DURATION_MIN
): boolean {
  if (!block.horaInicio || !block.horaFin) return true;

  const appointmentEndMinutes = appointmentStartMinutes + appointmentDurationMin;
  const blockStartMinutes = timeStringToMinutes(block.horaInicio);
  const blockEndMinutes = timeStringToMinutes(block.horaFin);

  return appointmentStartMinutes < blockEndMinutes && appointmentEndMinutes > blockStartMinutes;
}

export function hasBlockConflict(
  blocks: AvailabilityBlockCandidate[],
  appointmentStartMinutes: number,
  appointmentDurationMin: number = DEFAULT_APPOINTMENT_DURATION_MIN
): boolean {
  return blocks.some((block) => appointmentOverlapsBlock(block, appointmentStartMinutes, appointmentDurationMin));
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
