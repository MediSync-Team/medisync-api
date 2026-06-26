import prisma from '../lib/prisma';
import { DEFAULT_APPOINTMENT_DURATION_MIN, SLOT_GRID_STEP_MIN, appointmentFitsAvailability, hasAppointmentConflict, hasBlockConflict } from '../utils/appointment-conflicts';
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

    let [h, m] = disp.horaInicio.split(':').map(Number);
    const [hf, mf] = disp.horaFin.split(':').map(Number);

    while (h < hf || (h === hf && m < mf)) {
      const horaStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      const slotDate = clinicDateTimeToUtcDate(fecha, horaStr);
      const slotMinutes = h * 60 + m;
      const fitsAvailability = appointmentFitsAvailability(disp, slotMinutes, duracionMin);
      const ocupado = hasAppointmentConflict(turnosOcupados, slotDate, duracionMin);
      const bloqueado = hasBlockConflict(bloqueos, slotMinutes, duracionMin);

      if (fitsAvailability && !slotsMap.has(horaStr)) {
        slotsMap.set(horaStr, {
          disponible: !ocupado && !bloqueado,
          lugarAtencion: disp.lugarAtencion ?? null,
        });
      }

      m += SLOT_GRID_STEP_MIN;
      if (m >= 60) {
        h++;
        m -= 60;
      }
    }
  });

  return Array.from(slotsMap.entries())
    .map(([hora, { disponible, lugarAtencion }]) => ({ hora, disponible, lugarAtencion }))
    .sort((a, b) => a.hora.localeCompare(b.hora));
}
