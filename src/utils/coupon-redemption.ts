import { Prisma } from '@prisma/client';

export type CouponRedemptionResult = 'incremented' | 'exhausted' | 'missing';

export type CouponReversalResult = 'decremented' | 'missing' | 'floor';

type CouponTransaction = Pick<Prisma.TransactionClient, 'cupon'>;

/**
 * Redeems one coupon use without allowing usosActuales to pass maxUsos.
 * The conditional update protects against concurrent approvals using the same
 * last available coupon use.
 */
export async function redeemCouponUse(
  tx: CouponTransaction,
  cuponId: string
): Promise<CouponRedemptionResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const cupon = await tx.cupon.findUnique({
      where: { id: cuponId },
      select: { id: true, maxUsos: true, usosActuales: true },
    });

    if (!cupon) return 'missing';

    if (cupon.maxUsos === null) {
      await tx.cupon.update({
        where: { id: cuponId },
        data: { usosActuales: { increment: 1 } },
      });
      return 'incremented';
    }

    if (cupon.usosActuales >= cupon.maxUsos) {
      return 'exhausted';
    }

    const updated = await tx.cupon.updateMany({
      where: {
        id: cuponId,
        usosActuales: cupon.usosActuales,
      },
      data: { usosActuales: { increment: 1 } },
    });

    if (updated.count === 1) {
      return 'incremented';
    }
  }

  const current = await tx.cupon.findUnique({
    where: { id: cuponId },
    select: { id: true, maxUsos: true, usosActuales: true },
  });

  if (!current) return 'missing';
  if (current.maxUsos !== null && current.usosActuales >= current.maxUsos) {
    return 'exhausted';
  }
  if (current.maxUsos === null) {
    await tx.cupon.update({
      where: { id: cuponId },
      data: { usosActuales: { increment: 1 } },
    });
    return 'incremented';
  }

  const updated = await tx.cupon.updateMany({
    where: {
      id: cuponId,
      usosActuales: current.usosActuales,
    },
    data: { usosActuales: { increment: 1 } },
  });

  return updated.count === 1 ? 'incremented' : 'exhausted';
}

/**
 * Releases one coupon use when a paid turno is refunded. Must be called only
 * from the code path that wins the APROBADO→REEMBOLSADO transition (refund
 * service or webhook), so each redeemed use is reverted at most once. The
 * `gt: 0` guard keeps usosActuales from going negative.
 */
export async function revertCouponUse(
  tx: CouponTransaction,
  cuponId: string
): Promise<CouponReversalResult> {
  const updated = await tx.cupon.updateMany({
    where: { id: cuponId, usosActuales: { gt: 0 } },
    data: { usosActuales: { decrement: 1 } },
  });

  if (updated.count === 1) return 'decremented';

  const cupon = await tx.cupon.findUnique({
    where: { id: cuponId },
    select: { id: true },
  });

  return cupon ? 'floor' : 'missing';
}
