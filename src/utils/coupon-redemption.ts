import { Prisma } from '@prisma/client';

export type CouponRedemptionResult = 'incremented' | 'exhausted' | 'missing';

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
