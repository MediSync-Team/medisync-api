import { describe, expect, it, beforeEach, jest } from '@jest/globals';

const mockPrisma = {
  pago: { findUnique: jest.fn() as any, updateMany: jest.fn() as any },
  $transaction: jest.fn() as any,
};
jest.mock('../lib/prisma', () => ({ __esModule: true, default: mockPrisma }));

const mockRefundMpPayment = jest.fn() as any;
jest.mock('../services/pagos/mercadopago', () => ({
  ...(jest.requireActual('../services/pagos/mercadopago') as object),
  refundMpPayment: (...args: any[]) => mockRefundMpPayment(...args),
}));

const mockResolveSellerCredentialsByTurno = jest.fn() as any;
jest.mock('../services/pagos/mp-credentials', () => ({
  resolveSellerCredentialsByTurno: (...args: any[]) => mockResolveSellerCredentialsByTurno(...args),
  callMpWithRefresh: async (creds: any, fn: any) => fn(creds.accessToken),
}));

const mockRevertCouponUse = jest.fn() as any;
jest.mock('../utils/coupon-redemption', () => ({
  revertCouponUse: (...args: any[]) => mockRevertCouponUse(...args),
}));

const mockSendNotification = jest.fn() as any;
jest.mock('../utils/notifications', () => ({
  sendNotification: (...args: any[]) => mockSendNotification(...args),
}));

import { refundPagoForTurno } from '../services/pagos/refund.service';

const sellerCreds = { accessToken: 'seller-token', vendedorId: '999', isSeller: true, usuarioId: 'user-1' };

function buildPago(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pago-1',
    turnoId: 'turno-1',
    estado: 'APROBADO',
    mpPaymentId: 'mp-pay-1',
    cuponId: null,
    turno: {
      fechaHora: new Date('2026-07-10T14:00:00Z'),
      paciente: { email: 'paciente@test.com', telefono: '+54911111111' },
      profesional: { nombre: 'Ana', apellido: 'García' },
    },
    ...overrides,
  };
}

describe('refundPagoForTurno', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveSellerCredentialsByTurno.mockResolvedValue(sellerCreds);
    mockRefundMpPayment.mockResolvedValue({ id: 12345, status: 'approved' });
    mockSendNotification.mockResolvedValue([]);
    // The service runs its state transition inside a transaction; hand it a tx
    // backed by the same mocks so assertions can see the calls.
    mockPrisma.$transaction.mockImplementation(async (fn: any) =>
      fn({ pago: mockPrisma.pago, cupon: {} }),
    );
    mockPrisma.pago.updateMany.mockResolvedValue({ count: 1 });
  });

  it('refunds an approved pago with the seller token and marks it REEMBOLSADO', async () => {
    mockPrisma.pago.findUnique.mockResolvedValue(buildPago());

    const result = await refundPagoForTurno('turno-1', { motivo: 'Cancelado por el profesional' });

    expect(result).toBe('refunded');
    expect(mockResolveSellerCredentialsByTurno).toHaveBeenCalledWith('turno-1');
    expect(mockRefundMpPayment).toHaveBeenCalledWith('mp-pay-1', 'seller-token', 'refund-pago-1');
    expect(mockPrisma.pago.updateMany).toHaveBeenCalledWith({
      where: { id: 'pago-1', estado: 'APROBADO' },
      data: expect.objectContaining({
        estado: 'REEMBOLSADO',
        mpStatus: 'refunded',
        mpRefundId: '12345',
        reembolsadoAt: expect.any(Date),
      }),
    });
    expect(mockSendNotification).toHaveBeenCalledWith(
      ['EMAIL', 'WHATSAPP'],
      expect.objectContaining({ event: 'PAGO_REEMBOLSADO', userEmail: 'paciente@test.com' }),
    );
  });

  it('returns no_payment without calling MP when there is no pago', async () => {
    mockPrisma.pago.findUnique.mockResolvedValue(null);
    expect(await refundPagoForTurno('turno-1')).toBe('no_payment');
    expect(mockRefundMpPayment).not.toHaveBeenCalled();
  });

  it('returns no_payment for a PENDIENTE pago', async () => {
    mockPrisma.pago.findUnique.mockResolvedValue(buildPago({ estado: 'PENDIENTE' }));
    expect(await refundPagoForTurno('turno-1')).toBe('no_payment');
    expect(mockRefundMpPayment).not.toHaveBeenCalled();
  });

  it('returns no_payment for an approved pago without mpPaymentId (free/coupon confirmation)', async () => {
    mockPrisma.pago.findUnique.mockResolvedValue(buildPago({ mpPaymentId: null }));
    expect(await refundPagoForTurno('turno-1')).toBe('no_payment');
    expect(mockRefundMpPayment).not.toHaveBeenCalled();
  });

  it('returns already_refunded without calling MP when already REEMBOLSADO', async () => {
    mockPrisma.pago.findUnique.mockResolvedValue(buildPago({ estado: 'REEMBOLSADO' }));
    expect(await refundPagoForTurno('turno-1')).toBe('already_refunded');
    expect(mockRefundMpPayment).not.toHaveBeenCalled();
  });

  it('returns failed and keeps the pago untouched when the MP call fails', async () => {
    mockPrisma.pago.findUnique.mockResolvedValue(buildPago());
    mockRefundMpPayment.mockRejectedValue(new Error('MP down'));

    expect(await refundPagoForTurno('turno-1')).toBe('failed');
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  it('reverts the coupon use when the pago had a coupon', async () => {
    mockPrisma.pago.findUnique.mockResolvedValue(buildPago({ cuponId: 'cupon-1' }));

    expect(await refundPagoForTurno('turno-1')).toBe('refunded');
    expect(mockRevertCouponUse).toHaveBeenCalledWith(expect.anything(), 'cupon-1');
  });

  it('does not revert the coupon when a concurrent webhook already refunded (count 0)', async () => {
    mockPrisma.pago.findUnique.mockResolvedValue(buildPago({ cuponId: 'cupon-1' }));
    mockPrisma.pago.updateMany.mockResolvedValue({ count: 0 });

    expect(await refundPagoForTurno('turno-1')).toBe('already_refunded');
    expect(mockRevertCouponUse).not.toHaveBeenCalled();
    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  it('still returns refunded when the notification fails', async () => {
    mockPrisma.pago.findUnique.mockResolvedValue(buildPago());
    mockSendNotification.mockRejectedValue(new Error('smtp boom'));

    expect(await refundPagoForTurno('turno-1')).toBe('refunded');
  });

  it('skips the notification when notify is false', async () => {
    mockPrisma.pago.findUnique.mockResolvedValue(buildPago());

    expect(await refundPagoForTurno('turno-1', { notify: false })).toBe('refunded');
    expect(mockSendNotification).not.toHaveBeenCalled();
  });
});
