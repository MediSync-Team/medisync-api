import prisma from '../lib/prisma';
import { notifyWaitlistForReleasedSlot } from './waitlist.service';
import { syncTurnoCancelled, syncTurnoCancelledForPaciente } from './calendar-sync.service';

/**
 * Clean up stale RESERVADO appointments where the professional requires payment,
 * the checkout was abandoned (no approved payment after 15 minutes),
 * releasing slots and notifying the waitlist and Google Calendar.
 */
export async function cleanupStaleReservations() {
  const cutoff = new Date(Date.now() - 15 * 60 * 1000); // 15 minutes ago

  const staleTurnos = await prisma.turno.findMany({
    where: {
      estado: 'RESERVADO',
      createdAt: { lt: cutoff },
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

  if (staleTurnos.length === 0) return;

  console.log(`[cleanup] Found ${staleTurnos.length} stale reservations to cancel`);

  for (const turno of staleTurnos) {
    try {
      const updated = await prisma.$transaction(async (tx) => {
        // Re-verify under transaction lock to prevent race conditions
        const current = await tx.turno.findUnique({
          where: { id: turno.id },
          select: { estado: true },
        });

        if (!current || current.estado !== 'RESERVADO') {
          return null;
        }

        return await tx.turno.update({
          where: { id: turno.id },
          data: {
            estado: 'CANCELADO',
            notasCancelacion: 'Reserva expirada por falta de pago.',
          },
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
