import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { redeemCouponUse } from '../../utils/coupon-redemption';
import { isPayableTurnoState } from '../../utils/turno-state';

export interface ApprovePagoInput {
  /** MercadoPago payment id to persist on the pago. */
  paymentId: string | number;
  /** MercadoPago payment status (e.g. 'approved'); stored as `mpStatus`. */
  status?: string;
  /** Charged amount, used only when a pago row must be created from scratch. */
  amount: number;
}

/** A coupon that could not be redeemed at approval time (over capacity / missing). */
export interface CouponRedemptionWarning {
  turnoId: string;
  pagoId: string;
  cuponId: string;
  mpPaymentId: string;
  redemption: 'exhausted' | 'missing';
}

export type ApprovePagoResult =
  | { skipped: true; turnoEstado: string }
  | {
      skipped: false;
      pago: Prisma.PagoGetPayload<object>;
      turno: Prisma.TurnoGetPayload<{ include: { paciente: true; profesional: true } }>;
      couponWarning: CouponRedemptionWarning | null;
    };

/**
 * Approve the pago of a turno and confirm the turno, atomically. Shared by the
 * MercadoPago webhook and the `/pago-exitoso` reconciliation path
 * (`confirmarPago`), so both apply the exact same idempotent transition.
 *
 * Idempotency: the pago is flipped to APROBADO only from a non-APROBADO state
 * (conditional `updateMany`), and the coupon is redeemed only by the caller that
 * wins that transition. A concurrent webhook + reconciliation therefore approve
 * once and redeem the coupon once; the loser returns `skipped`.
 */
export async function approvePagoForTurno(turnoId: string, input: ApprovePagoInput): Promise<ApprovePagoResult> {
  const { paymentId, status, amount } = input;

  return prisma.$transaction(async (tx) => {
    const turnoActual = await tx.turno.findUnique({
      where: { id: turnoId },
      include: { pago: true, paciente: true, profesional: true },
    });

    if (!turnoActual || !isPayableTurnoState(turnoActual.estado)) {
      return { skipped: true as const, turnoEstado: turnoActual?.estado ?? 'MISSING' };
    }

    if (turnoActual.pago?.estado === 'APROBADO') {
      return { skipped: true as const, turnoEstado: turnoActual.estado };
    }

    const paymentData = {
      estado: 'APROBADO' as const,
      mpPaymentId: String(paymentId),
      mpStatus: status,
    };
    let pago = turnoActual.pago;

    if (pago) {
      const updated = await tx.pago.updateMany({
        where: { turnoId, estado: { not: 'APROBADO' } },
        data: paymentData,
      });

      if (updated.count === 0) {
        return { skipped: true as const, turnoEstado: turnoActual.estado };
      }

      pago = await tx.pago.findUnique({ where: { turnoId } });
    } else {
      try {
        pago = await tx.pago.create({
          data: { turnoId, monto: amount, montoNeto: amount, ...paymentData },
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

    // Keep coupon usage tied to the one caller that newly approves the payment.
    let couponWarning: CouponRedemptionWarning | null = null;
    if (pago.cuponId) {
      const redemption = await redeemCouponUse(tx, pago.cuponId);
      if (redemption !== 'incremented') {
        couponWarning = {
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

    return { skipped: false as const, pago, turno, couponWarning };
  });
}
