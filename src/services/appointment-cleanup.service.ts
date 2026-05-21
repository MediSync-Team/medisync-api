import prisma from '../lib/prisma';
import { notifyWaitlistForReleasedSlot } from './waitlist.service';
import { syncTurnoCancelled, syncTurnoCancelledForPaciente } from './calendar-sync.service';
import { getAppointmentEnd } from '../utils/appointment-conflicts';

const UNPAID_RESERVATION_GRACE_MS = 60 * 60 * 1000;

/**
 * Clean up stale RESERVADO appointments where the professional requires payment,
 * the checkout was abandoned (no approved payment one hour after the appointment ends),
 * releasing slots and notifying the waitlist and Google Calendar.
 */
export async function cleanupStaleReservations() {
  const now = new Date();
  const broadCutoff = new Date(now.getTime() - UNPAID_RESERVATION_GRACE_MS);

  const staleTurnos = await prisma.turno.findMany({
    where: {
      estado: 'RESERVADO',
      fechaHora: { lt: broadCutoff },
      profesional: {
        precioConsulta: { gt: 0 },
      },
      OR: [
        { pago: null },
        { pago: { estado: { not: 'APROBADO' } } },
      ],
    },
    include: {
      profesional: true,
      paciente: true,
    },
  });

  const expiredTurnos = staleTurnos.filter((turno) => {
    const appointmentEnd = getAppointmentEnd(turno.fechaHora, turno.duracionMin);
    const eligibleAt = new Date(appointmentEnd.getTime() + UNPAID_RESERVATION_GRACE_MS);
    return eligibleAt <= now;
  });

  if (expiredTurnos.length === 0) return;

  console.log(`[cleanup] Found ${expiredTurnos.length} expired unpaid reservations to cancel`);

  for (const turno of expiredTurnos) {
    try {
      const updated = await prisma.$transaction(async (tx) => {
        const result = await tx.turno.updateMany({
          where: {
            id: turno.id,
            estado: 'RESERVADO',
            OR: [
              { pago: null },
              { pago: { estado: { not: 'APROBADO' } } },
            ],
          },
          data: {
            estado: 'CANCELADO',
            notasCancelacion: 'Reserva expirada por falta de pago.',
          },
        });

        if (result.count === 0) {
          return null;
        }

        return await tx.turno.findUnique({
          where: { id: turno.id },
        });
      });

      if (!updated) continue;

      console.log(`[cleanup] Cancelled stale turno ${turno.id} for slot ${turno.fechaHora.toISOString()}`);

      // Notify waitlist
      await notifyWaitlistForReleasedSlot({
        profesionalId: turno.profesionalId,
        fechaHora: turno.fechaHora,
        modalidad: turno.modalidad as 'PRESENCIAL' | 'VIRTUAL',
        turnoId: turno.id,
      }).catch((err) => {
        console.error(`[cleanup] Waitlist notification failed for turno ${turno.id}:`, err);
      });

      // Sync Google Calendar cancellations
      syncTurnoCancelled(turno.id).catch(() => {});
      syncTurnoCancelledForPaciente(turno.id).catch(() => {});
    } catch (err) {
      console.error(`[cleanup] Error processing stale turno ${turno.id}:`, err);
    }
  }
}
