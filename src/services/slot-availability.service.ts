import prisma from '../lib/prisma';
import { DEFAULT_APPOINTMENT_DURATION_MIN, hasAppointmentConflict, hasBlockConflict, timeStringToMinutes } from '../utils/appointment-conflicts';
import {
  clinicDateTimeToUtcDate,
  getClinicDateOnlyUtc,
  getClinicDayBoundsFromDateString,
  getClinicWeekdayFromDateString,
} from '../utils/clinic-time';

export type AvailableSlot = {
  hora: string;
  disponible: boolean;
  lugarAtencion: string | null;
};

export async function getAvailableSlotsForProfessional(params: {
  profesionalId: string;
  fecha: string;
  modalidad?: string;
  duracionMin?: number;
}): Promise<AvailableSlot[]> {
  const { profesionalId, fecha, modalidad } = params;
  const duracionMin = params.duracionMin ?? DEFAULT_APPOINTMENT_DURATION_MIN;
  const diaSemana = getClinicWeekdayFromDateString(fecha);
  const fechaDate = getClinicDateOnlyUtc(fecha);
  const { start: startOfDay, end: endOfDay } = getClinicDayBoundsFromDateString(fecha);

  const [disponibilidad, turnosOcupados, bloqueos] = await Promise.all([
    prisma.disponibilidad.findMany({
      where: { profesionalId, diaSemana, activo: true },
    }),
    prisma.turno.findMany({
      where: {
        profesionalId,
        fechaHora: { gte: startOfDay, lt: endOfDay },
        estado: { notIn: ['CANCELADO'] },
      },
    }),
    prisma.bloqueoDisponibilidad.findMany({
      where: {
        profesionalId,
        fechaInicio: { lte: fechaDate },
        fechaFin: { gte: fechaDate },
      },
    }),
  ]);

  const fullDayBlock = bloqueos.some((bloqueo) => !bloqueo.horaInicio && !bloqueo.horaFin);
  if (fullDayBlock) return [];

  const slotsMap = new Map<string, { disponible: boolean; lugarAtencion: string | null }>();

  disponibilidad.forEach((disp) => {
    if (modalidad && disp.modalidad !== modalidad && disp.modalidad !== 'AMBOS') return;

    const startMinutes = timeStringToMinutes(disp.horaInicio);
    const endMinutes = timeStringToMinutes(disp.horaFin);

    // Step the grid by the appointment duration (not a fixed 15-min step) so the
    // offered start times tile the window without overlapping. This keeps a booked
    // slot from also knocking out its neighbours, and makes the final slot that ends
    // exactly at the availability end appear. Start times are anchored to horaInicio,
    // so a window that opens at e.g. 08:20 is bookable even though :20 is not on the
    // absolute :00/:15/:30/:45 grid.
    for (let slotMinutes = startMinutes; slotMinutes + duracionMin <= endMinutes; slotMinutes += duracionMin) {
      const h = Math.floor(slotMinutes / 60);
      const m = slotMinutes % 60;
      const horaStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      if (slotsMap.has(horaStr)) continue;

      const slotDate = clinicDateTimeToUtcDate(fecha, horaStr);
      const ocupado = hasAppointmentConflict(turnosOcupados, slotDate, duracionMin);
      const bloqueado = hasBlockConflict(bloqueos, slotMinutes, duracionMin);

      slotsMap.set(horaStr, {
        disponible: !ocupado && !bloqueado,
        lugarAtencion: disp.lugarAtencion ?? null,
      });
    }
  });

  return Array.from(slotsMap.entries())
    .map(([hora, { disponible, lugarAtencion }]) => ({ hora, disponible, lugarAtencion }))
    .sort((a, b) => a.hora.localeCompare(b.hora));
}
