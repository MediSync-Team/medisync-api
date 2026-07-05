import prisma from '../../lib/prisma';
import { AppError } from '../../utils/response';
import { sendNotification } from '../../utils/notifications';
import { isPayableTurnoState } from '../../utils/turno-state';
import { formatClinicDateTimeEs } from '../../utils/clinic-time';
import { searchMpPaymentsByExternalReference } from './mercadopago';
import { resolveSellerCredentialsByTurno, callMpWithRefresh } from './mp-credentials';
import { approvePagoForTurno } from './payment-approval.service';

export interface PagoQueryInput {
  userId: string;
  turnoId: string;
}

/** Return the pago estado for a turno the user can access (paciente or profesional). */
export async function getPagoEstado({ userId, turnoId }: PagoQueryInput) {
  const turno = await prisma.turno.findUnique({
    where: { id: turnoId },
    include: { paciente: true, profesional: true },
  });

  if (!turno) {
    throw new AppError(404, 'NOT_FOUND', 'Turno no encontrado');
  }

  const hasAccess = turno.paciente?.usuarioId === userId || turno.profesional.usuarioId === userId;
  if (!hasAccess) {
    throw new AppError(403, 'FORBIDDEN', 'Sin permisos para ver este pago');
  }

  const pago = await prisma.pago.findUnique({ where: { turnoId } });

  if (!pago) {
    return { estado: null };
  }

  return {
    estado: pago.estado,
    monto: pago.monto,
    necesitaPago: pago.estado !== 'APROBADO',
    initPoint: pago.estado !== 'APROBADO' ? `/pago?turno=${turnoId}` : null,
  };
}

/**
 * Confirm a turno (→ CONFIRMADO) when its pago is APROBADO. Called by
 * `/pago-exitoso` when the patient returns from checkout. If the pago is still
 * PENDIENTE (the webhook may not have arrived), reconcile against MercadoPago:
 * search the seller's payments by external_reference and, if one is approved,
 * apply the same idempotent transition the webhook uses.
 */
export async function confirmarPago({ userId, turnoId }: PagoQueryInput) {
  const turno = await prisma.turno.findUnique({
    where: { id: turnoId },
    include: { paciente: true },
  });

  if (!turno) {
    throw new AppError(404, 'NOT_FOUND', 'Turno no encontrado');
  }

  if (!turno.paciente || turno.paciente.usuarioId !== userId) {
    throw new AppError(403, 'FORBIDDEN', 'Sin permisos para confirmar este pago');
  }

  const canConfirmTurno = isPayableTurnoState(turno.estado);
  let pago = await prisma.pago.findUnique({ where: { turnoId } });
  let turnoEstado = turno.estado;

  // Reconcile: the patient just returned from checkout, so MercadoPago may have
  // an approved payment while our pago is still PENDIENTE (webhook not yet
  // delivered). Best-effort — a failure here must never break /pago-exitoso.
  if (pago && pago.estado !== 'APROBADO' && pago.estado !== 'REEMBOLSADO' && canConfirmTurno) {
    try {
      const creds = await resolveSellerCredentialsByTurno(turnoId);
      const search = await callMpWithRefresh(creds, (token) =>
        searchMpPaymentsByExternalReference(turnoId, token),
      );
      const approvedPayment = search.results?.find((p) => p.status === 'approved' && p.id != null);

      if (approvedPayment?.id != null) {
        const result = await approvePagoForTurno(turnoId, {
          paymentId: approvedPayment.id,
          status: 'approved',
          amount: Number(approvedPayment.transaction_amount || 0),
        });
        pago = await prisma.pago.findUnique({ where: { turnoId } });

        if (!result.skipped) {
          turnoEstado = result.turno.estado;
          if (result.couponWarning) {
            console.warn('[pagos] Coupon capacity exhausted after paid approval', result.couponWarning);
          }
          try {
            await sendNotification(['EMAIL', 'WHATSAPP'], {
              event: 'TURNO_CONFIRMADO',
              title: 'Pago aprobado — Turno confirmado',
              message: `Tu pago fue aprobado y el turno del ${formatClinicDateTimeEs(result.turno.fechaHora)} quedó confirmado.`,
              userEmail: result.turno.paciente?.email,
              userPhone: result.turno.paciente?.telefono,
              meta: {
                turnoId: result.turno.id,
                fechaHora: result.turno.fechaHora.toISOString(),
                profesional: `Dr/a. ${result.turno.profesional.nombre} ${result.turno.profesional.apellido}`,
                modalidad: result.turno.modalidad,
                lugarAtencion: result.turno.profesional.lugarAtencion ?? undefined,
                pagoId: result.pago.id,
                mpPaymentId: approvedPayment.id,
              },
            });
          } catch (err) {
            console.error('Error enviando notificación de pago aprobado:', err);
          }
        }
      }
    } catch (err) {
      console.error('[pagos] Reconciliación con MercadoPago falló', { turnoId, err });
    }
  }

  // Confirm the turno when the pago is approved (webhook already ran, or a race
  // where reconciliation lost but the pago is now APROBADO).
  if (pago?.estado === 'APROBADO' && turnoEstado !== 'CONFIRMADO' && canConfirmTurno) {
    await prisma.turno.update({
      where: { id: turnoId },
      data: { estado: 'CONFIRMADO' },
    });
    turnoEstado = 'CONFIRMADO';
  }

  return {
    confirmed: pago?.estado === 'APROBADO' && canConfirmTurno,
    estado: pago?.estado || null,
    turnoEstado,
  };
}
