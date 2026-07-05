import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { redeemCouponUse, revertCouponUse } from '../utils/coupon-redemption';

const tx = {
  cupon: {
    findUnique: jest.fn() as any,
    update: jest.fn() as any,
    updateMany: jest.fn() as any,
  },
};

describe('redeemCouponUse', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    tx.cupon.update.mockResolvedValue({});
    tx.cupon.updateMany.mockResolvedValue({ count: 1 });
  });

  it('increments when usage is below maxUsos', async () => {
    tx.cupon.findUnique.mockResolvedValue({ id: 'cupon-1', maxUsos: 2, usosActuales: 1 });

    const result = await redeemCouponUse(tx as any, 'cupon-1');

    expect(result).toBe('incremented');
    expect(tx.cupon.updateMany).toHaveBeenCalledWith({
      where: { id: 'cupon-1', usosActuales: 1 },
      data: { usosActuales: { increment: 1 } },
    });
    expect(tx.cupon.update).not.toHaveBeenCalled();
  });

  it('refuses when coupon is exhausted', async () => {
    tx.cupon.findUnique.mockResolvedValue({ id: 'cupon-1', maxUsos: 2, usosActuales: 2 });

    const result = await redeemCouponUse(tx as any, 'cupon-1');

    expect(result).toBe('exhausted');
    expect(tx.cupon.updateMany).not.toHaveBeenCalled();
    expect(tx.cupon.update).not.toHaveBeenCalled();
  });

  it('increments unlimited coupons', async () => {
    tx.cupon.findUnique.mockResolvedValue({ id: 'cupon-1', maxUsos: null, usosActuales: 99 });

    const result = await redeemCouponUse(tx as any, 'cupon-1');

    expect(result).toBe('incremented');
    expect(tx.cupon.update).toHaveBeenCalledWith({
      where: { id: 'cupon-1' },
      data: { usosActuales: { increment: 1 } },
    });
    expect(tx.cupon.updateMany).not.toHaveBeenCalled();
  });

  it('returns missing for deleted coupons', async () => {
    tx.cupon.findUnique.mockResolvedValue(null);

    const result = await redeemCouponUse(tx as any, 'cupon-1');

    expect(result).toBe('missing');
    expect(tx.cupon.updateMany).not.toHaveBeenCalled();
    expect(tx.cupon.update).not.toHaveBeenCalled();
  });

  it('refetches after a stale conditional update loses and does not increment past capacity', async () => {
    tx.cupon.findUnique
      .mockResolvedValueOnce({ id: 'cupon-1', maxUsos: 1, usosActuales: 0 })
      .mockResolvedValueOnce({ id: 'cupon-1', maxUsos: 1, usosActuales: 1 });
    tx.cupon.updateMany.mockResolvedValue({ count: 0 });

    const result = await redeemCouponUse(tx as any, 'cupon-1');

    expect(result).toBe('exhausted');
    expect(tx.cupon.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.cupon.update).not.toHaveBeenCalled();
  });
});

describe('revertCouponUse', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('decrements a redeemed use', async () => {
    tx.cupon.updateMany.mockResolvedValue({ count: 1 });

    const result = await revertCouponUse(tx as any, 'cupon-1');

    expect(result).toBe('decremented');
    expect(tx.cupon.updateMany).toHaveBeenCalledWith({
      where: { id: 'cupon-1', usosActuales: { gt: 0 } },
      data: { usosActuales: { decrement: 1 } },
    });
  });

  it('floors at zero instead of going negative', async () => {
    tx.cupon.updateMany.mockResolvedValue({ count: 0 });
    tx.cupon.findUnique.mockResolvedValue({ id: 'cupon-1' });

    const result = await revertCouponUse(tx as any, 'cupon-1');

    expect(result).toBe('floor');
  });

  it('returns missing for deleted coupons', async () => {
    tx.cupon.updateMany.mockResolvedValue({ count: 0 });
    tx.cupon.findUnique.mockResolvedValue(null);

    const result = await revertCouponUse(tx as any, 'cupon-1');

    expect(result).toBe('missing');
  });
});
