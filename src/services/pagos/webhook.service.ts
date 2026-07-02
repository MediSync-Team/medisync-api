import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { AppError } from '../../utils/response';
import { sendNotification } from '../../utils/notifications';
import { redeemCouponUse, revertCouponUse } from '../../utils/coupon-redemption';
import { isPayableTurnoState } from '../../utils/turno-state';
import { formatClinicDateTimeEs } from '../../utils/clinic-time';
import { fetchMpPayment, isValidWebhookSignature, MercadoPagoWebhookBody } from './mercadopago';
import { resolveWebhookCredentials, callMpWithRefresh } from './mp-credentials';

export interface ProcessPaymentWebhookInput {
  body: MercadoPagoWebhookBody;
  signature: string | undefined;
  requestId: string | undefined;
  /** From the notification_url query — identifies the seller whose token owns the payment. */
  turnoId?: string;
}

/**
 * Process a MercadoPago webhook. Only `payment` events do work; everything else
 * is a no-op (the handler always acknowledges with `{ received: true }`).
 * Throws `AppError(401)` on a bad signature and `AppError(500)` on processing failure.
 */
export async function processPaymentWebhook({ body, signature, requestId, turnoId: turnoIdHint }: ProcessPaymentWebhookInput): Promise<void> {
  const type = body.type;
  const data = body.data;

  if (type !== 'payment') return;

  const paymentId = data?.id;

  if (!paymentId || !isValidWebhookSignature(signature, requestId, String(paymentId))) {
    throw new AppError(401, 'INVALID_WEBHOOK_SIGNATURE', 'Webhook no autorizado');
  }

  try {
    // The payment lives in the seller's MP account (split payments), so it must be
    // fetched with the seller's token — resolved from the turnoId carried on the
    // notification_url. Falls back to the platform token when unknown.
    const creds = await resolveWebhookCredentials(turnoIdHint);
    const payment = await callMpWithRefresh(creds, (token) => fetchMpPayment(paymentId, token));
    const turnoId = payment.external_reference;

    if (turnoId && payment.status === 'approved') {
      let couponRedemptionWarning: {
        turnoId: string;
        pagoId: string;
        cuponId: string;
        mpPaymentId: string;
        redemption: 'exhausted' | 'missing';
      } | null = null;

      // Pago approval, coupon usage, and turno confirmation must commit together.
      const approved = await prisma.$transaction(async (tx) => {
        const turnoActual = await tx.turno.findUnique({
          where: { id: turnoId },
          include: {
            pago: true,
            paciente: true,
            profesional: true,
          },
        });

        if (!turnoActual || !isPayableTurnoState(turnoActual.estado)) {
          return {
            skipped: true as const,
            turnoEstado: turnoActual?.estado ?? 'MISSING',
          };
        }

        if (turnoActual.pago?.estado === 'APROBADO') {
          return { skipped: true as const, turnoEstado: turnoActual.estado };
        }

        const paymentData = {
          estado: 'APROBADO' as const,
          mpPaymentId: String(paymentId),
          mpStatus: payment.status,
        };
        const amount = Number(payment.transaction_amount || 0);
        let pago = turnoActual.pago;

        if (pago) {
          const updated = await tx.pago.updateMany({
            where: {
              turnoId,
              estado: { not: 'APROBADO' },
            },
            data: paymentData,
          });

          if (updated.count === 0) {
            return { skipped: true as const, turnoEstado: turnoActual.estado };
          }

          pago = await tx.pago.findUnique({ where: { turnoId } });
        } else {
          try {
            pago = await tx.pago.create({
              data: {
                turnoId,
                monto: amount,
                montoNeto: amount,
                ...paymentData,
              },
            });
          } catch (err) {
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
              return { skipped: true as const, turnoEstado: turnoActual.estado };
            }
            throw err;
          }
        }

        if (!pago) {
          return { skipped: true as const, turnoEstado: turnoActual.estado };
        }

        // Keep coupon usage tied to the one webhook that newly approves the payment.
        if (pago.cuponId) {
          const redemption = await redeemCouponUse(tx, pago.cuponId);
          if (redemption !== 'incremented') {
            couponRedemptionWarning = {
              turnoId,
              pagoId: pago.id,
              cuponId: pago.cuponId,
              mpPaymentId: String(paymentId),
              redemption,
            };
          }
        }

        const turno = await tx.turno.update({
          where: { id: turnoId },
          data: { estado: 'CONFIRMADO' },
          include: { paciente: true, profesional: true },
        });

        return { skipped: false as const, pago, turno };
      });

      if (approved.skipped) {
        if (approved.turnoEstado === 'MISSING' || !isPayableTurnoState(approved.turnoEstado)) {
          console.warn('[pagos] Ignoring approved payment for non-payable turno', {
            turnoId,
            turnoEstado: approved.turnoEstado,
            mpPaymentId: String(paymentId),
          });
        }
        return;
      }

      const { pago, turno } = approved;

      if (couponRedemptionWarning) {
        console.warn('[pagos] Coupon capacity exhausted after paid approval', couponRedemptionWarning);
      }

      try {
        await sendNotification(['EMAIL', 'WHATSAPP'], {
          event: 'TURNO_CONFIRMADO',
          title: 'Pago aprobado — Turno confirmado',
          message: `Tu pago fue aprobado y el turno del ${formatClinicDateTimeEs(turno.fechaHora)} quedó confirmado.`,
          userEmail: turno.paciente?.email,
          userPhone: turno.paciente?.telefono,
          meta: {
            turnoId: turno.id,
            fechaHora: turno.fechaHora.toISOString(),
            profesional: `Dr/a. ${turno.profesional.nombre} ${turno.profesional.apellido}`,
            modalidad: turno.modalidad,
            lugarAtencion: turno.profesional.lugarAtencion ?? undefined,
            pagoId: pago.id,
            mpPaymentId: paymentId,
          },
        });
      } catch (err) {
        console.error('Error enviando notificación de pago aprobado:', err);
      }
    } else if (turnoId && (payment.status === 'refunded' || payment.status === 'cancelled')) {
      // Refund reconciliation. Covers refunds initiated from the MP panel; the
      // ones our own refund service issued already left the pago REEMBOLSADO,
      // so the conditional update no-ops (as do duplicate deliveries). Matching
      // on the approved mpPaymentId keeps a 'cancelled' notification for an
      // abandoned, never-approved attempt from touching a PENDIENTE pago.
      const reconciled = await prisma.$transaction(async (tx) => {
        const updated = await tx.pago.updateMany({
          where: { turnoId, mpPaymentId: String(paymentId), estado: { not: 'REEMBOLSADO' } },
          data: { estado: 'REEMBOLSADO', mpStatus: payment.status, reembolsadoAt: new Date() },
        });

        if (updated.count === 0) {
          return { skipped: true as const };
        }

        const pago = await tx.pago.findUnique({ where: { turnoId } });
        if (pago?.cuponId) {
          await revertCouponUse(tx, pago.cuponId);
        }

        // A refund from outside the app on a still-active turno cancels it: a
        // confirmed appointment must never stand without a payment behind it.
        let turno = await tx.turno.findUnique({
          where: { id: turnoId },
          include: { paciente: true, profesional: true },
        });
        let turnoCancelado = false;
        if (turno && (turno.estado === 'RESERVADO' || turno.estado === 'CONFIRMADO')) {
          turno = await tx.turno.update({
            where: { id: turnoId },
            data: { estado: 'CANCELADO', notasCancelacion: 'Pago reembolsado en Mercado Pago.' },
            include: { paciente: true, profesional: true },
          });
          turnoCancelado = true;
        }

        return { skipped: false as const, turno, turnoCancelado };
      });

      if (!reconciled.skipped && reconciled.turno) {
        const { turno, turnoCancelado } = reconciled;
        try {
          await sendNotification(['EMAIL', 'WHATSAPP'], {
            event: 'PAGO_REEMBOLSADO',
            title: turnoCancelado ? 'Pago reembolsado — Turno cancelado' : 'Pago reembolsado',
            message: turnoCancelado
              ? `Tu pago fue reembolsado y el turno del ${formatClinicDateTimeEs(turno.fechaHora)} quedó cancelado. Vas a ver el reintegro en tu medio de pago de Mercado Pago.`
              : `Tu pago del turno del ${formatClinicDateTimeEs(turno.fechaHora)} fue reembolsado. Vas a ver el reintegro en tu medio de pago de Mercado Pago.`,
            userEmail: turno.paciente?.email,
            userPhone: turno.paciente?.telefono,
            meta: {
              turnoId,
              fechaHora: turno.fechaHora.toISOString(),
              profesional: `Dr/a. ${turno.profesional.nombre} ${turno.profesional.apellido}`,
              mpPaymentId: String(paymentId),
            },
          });
        } catch (err) {
          console.error('Error enviando notificación de reembolso:', err);
        }
      }
    }
  } catch (err) {
    console.error('Error procesando webhook:', err);
    throw new AppError(500, 'WEBHOOK_PROCESSING_FAILED', 'Error procesando webhook de pago');
  }
}
