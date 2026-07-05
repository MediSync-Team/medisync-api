import prisma from '../../lib/prisma';
import { sendNotification } from '../../utils/notifications';
import { revertCouponUse } from '../../utils/coupon-redemption';
import { formatClinicDateTimeEs } from '../../utils/clinic-time';
import { refundMpPayment } from './mercadopago';
import { resolveSellerCredentialsByTurno, callMpWithRefresh } from './mp-credentials';

export type RefundResult = 'refunded' | 'no_payment' | 'already_refunded' | 'failed';

export interface RefundOptions {
  /** Free-text reason forwarded to the patient notification. */
  motivo?: string;
  /** Set false to skip the patient notification (default true). */
  notify?: boolean;
}

/**
 * Refund the approved MercadoPago payment of a turno, in full (partial refunds
 * are out of scope for v1). The refund must be issued with the same account
 * that collected the payment — the professional's linked token for split
 * payments — so credentials are resolved per-turno. On MP success the pago
 * flips APROBADO→REEMBOLSADO and the coupon use (if any) is released.
 *
 * Never throws: cancellation flows call this as a side effect and must not
 * fail because MP is down. On `'failed'` the pago stays APROBADO so the manual
 * endpoint (`POST /pagos/:turnoId/reembolsar`) or a `refunded` webhook can
 * reconcile later.
 */
export async function refundPagoForTurno(turnoId: string, opts: RefundOptions = {}): Promise<RefundResult> {
  const pago = await prisma.pago.findUnique({
    where: { turnoId },
    include: {
      turno: {
        include: { paciente: true, profesional: true },
      },
    },
  });

  if (!pago) return 'no_payment';
  if (pago.estado === 'REEMBOLSADO') return 'already_refunded';
  if (pago.estado !== 'APROBADO' || !pago.mpPaymentId) return 'no_payment';

  let refundId: string;
  try {
    const creds = await resolveSellerCredentialsByTurno(turnoId);
    const refund = await callMpWithRefresh(creds, (token) =>
      refundMpPayment(pago.mpPaymentId!, token, `refund-${pago.id}`),
    );
    refundId = String(refund.id);
  } catch (err) {
    console.error('[pagos] Reembolso falló', { turnoId, pagoId: pago.id, mpPaymentId: pago.mpPaymentId, err });
    return 'failed';
  }

  const updated = await prisma.$transaction(async (tx) => {
    // Conditional transition: if a concurrent `refunded` webhook already flipped
    // the pago, count === 0 and the coupon must NOT be reverted a second time.
    const result = await tx.pago.updateMany({
      where: { id: pago.id, estado: 'APROBADO' },
      data: {
        estado: 'REEMBOLSADO',
        mpStatus: 'refunded',
        mpRefundId: refundId,
        reembolsadoAt: new Date(),
      },
    });

    if (result.count === 1 && pago.cuponId) {
      await revertCouponUse(tx, pago.cuponId);
    }

    return result.count;
  });

  if (updated === 0) {
    return 'already_refunded';
  }

  if (opts.notify !== false) {
    try {
      const { turno } = pago;
      await sendNotification(['EMAIL', 'WHATSAPP'], {
        event: 'PAGO_REEMBOLSADO',
        title: 'Pago reembolsado',
        message: `Te devolvimos el pago del turno del ${formatClinicDateTimeEs(turno.fechaHora)}${opts.motivo ? ` (${opts.motivo})` : ''}. Vas a ver el reintegro en tu medio de pago de Mercado Pago.`,
        userEmail: turno.paciente?.email,
        userPhone: turno.paciente?.telefono,
        meta: {
          turnoId,
          fechaHora: turno.fechaHora.toISOString(),
          profesional: `Dr/a. ${turno.profesional.nombre} ${turno.profesional.apellido}`,
          pagoId: pago.id,
          mpPaymentId: pago.mpPaymentId,
          mpRefundId: refundId,
        },
      });
    } catch (err) {
      console.error('Error enviando notificación de reembolso:', err);
    }
  }

  return 'refunded';
}
