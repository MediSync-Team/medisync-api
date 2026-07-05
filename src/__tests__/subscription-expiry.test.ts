import { describe, expect, it, beforeEach, jest } from '@jest/globals';

const mockPrisma = {
  profesional: { updateMany: jest.fn() as any },
};
jest.mock('../lib/prisma', () => ({ __esModule: true, default: mockPrisma }));

import { downgradeExpiredProPlans } from '../services/subscription-expiry.service';

describe('downgradeExpiredProPlans', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('downgrades only PRO plans with a past planVenceAt and returns the count', async () => {
    mockPrisma.profesional.updateMany.mockResolvedValue({ count: 3 });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const count = await downgradeExpiredProPlans();

    expect(count).toBe(3);
    expect(mockPrisma.profesional.updateMany).toHaveBeenCalledWith({
      where: {
        plan: 'PRO',
        // `not: null` excluye los PRO otorgados a mano (sin vencimiento);
        // `lt: now` excluye los que siguen vigentes.
        planVenceAt: { not: null, lt: expect.any(Date) },
      },
      data: { plan: 'FREE', planVenceAt: null },
    });
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('is silent when nothing expired', async () => {
    mockPrisma.profesional.updateMany.mockResolvedValue({ count: 0 });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const count = await downgradeExpiredProPlans();

    expect(count).toBe(0);
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });
});
