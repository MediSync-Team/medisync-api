import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { AppError } from '../../utils/response';
import { sendNotification } from '../../utils/notifications';
import { redeemCouponUse } from '../../utils/coupon-redemption';
import { isPayableTurnoState } from '../../utils/turno-state';
import { formatClinicDateTimeEs } from '../../utils/clinic-time';
import { fetchMpPayment, isValidWebhookSignature, MercadoPagoWebhookBody } from './mercadopago';

export interface ProcessPaymentWebhookInput {
  body: MercadoPagoWebhookBody;
  signature: string | undefined;
  requestId: string | undefined;
}

/**
 * Process a MercadoPago webhook. Only `payment` events do work; everything else
 * is a no-op (the handler always acknowledges with `{ received: true }`).
 * Throws `AppError(401)` on a bad signature and `AppError(500)` on processing failure.
 */
export async function processPaymentWebhook({ body, signature, requestId }: ProcessPaymentWebhookInput): Promise<void> {
  const type = body.type;
  const data = body.data;

  if (type !== 'payment') return;

  const paymentId = data?.id;

  if (!paymentId || !isValidWebhookSignature(signature, requestId, String(paymentId))) {
    throw new AppError(401, 'INVALID_WEBHOOK_SIGNATURE', 'Webhook no autorizado');
  }

  try {
    const payment = await fetchMpPayment(paymentId);
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
    }
  } catch (err) {
    console.error('Error procesando webhook:', err);
    throw new AppError(500, 'WEBHOOK_PROCESSING_FAILED', 'Error procesando webhook de pago');
  }
}
