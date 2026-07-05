import { describe, expect, it, beforeEach, jest } from '@jest/globals';

const mockPrisma = {
  turno: { findUnique: jest.fn() as any, update: jest.fn() as any },
  pago: { findUnique: jest.fn() as any },
};
jest.mock('../lib/prisma', () => ({ __esModule: true, default: mockPrisma }));

const mockSearch = jest.fn() as any;
jest.mock('../services/pagos/mercadopago', () => ({
  searchMpPaymentsByExternalReference: (...args: any[]) => mockSearch(...args),
}));

const mockResolveSeller = jest.fn() as any;
jest.mock('../services/pagos/mp-credentials', () => ({
  resolveSellerCredentialsByTurno: (...args: any[]) => mockResolveSeller(...args),
  callMpWithRefresh: async (creds: any, fn: any) => fn(creds.accessToken),
}));

const mockApprove = jest.fn() as any;
jest.mock('../services/pagos/payment-approval.service', () => ({
  approvePagoForTurno: (...args: any[]) => mockApprove(...args),
}));

const mockSendNotification = jest.fn() as any;
jest.mock('../utils/notifications', () => ({
  sendNotification: (...args: any[]) => mockSendNotification(...args),
}));

import { confirmarPago } from '../services/pagos/pago-query.service';

const userId = 'user-paciente-1';
const turnoId = 'turno-1';
const sellerCreds = { accessToken: 'seller-token', vendedorId: '999', isSeller: true, usuarioId: 'user-prof' };

function mockTurno(estado = 'RESERVADO') {
  mockPrisma.turno.findUnique.mockResolvedValue({
    id: turnoId,
    estado,
    paciente: { usuarioId: userId, email: 'paciente@test.com' },
  });
}

function approvedResult() {
  return {
    skipped: false,
    couponWarning: null,
    pago: { id: 'pago-1' },
    turno: {
      id: turnoId,
      estado: 'CONFIRMADO',
      fechaHora: new Date('2026-07-10T14:00:00Z'),
      modalidad: 'PRESENCIAL',
      paciente: { email: 'paciente@test.com', telefono: null },
      profesional: { nombre: 'Ana', apellido: 'García', lugarAtencion: 'Consultorio' },
    },
  };
}

describe('confirmarPago — reconciliación con MercadoPago', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveSeller.mockResolvedValue(sellerCreds);
    mockSendNotification.mockResolvedValue([]);
    mockPrisma.turno.update.mockResolvedValue({ id: turnoId, estado: 'CONFIRMADO' });
  });

  it('reconcilia contra MP: pago PENDIENTE + MP approved → aprueba, confirma y notifica', async () => {
    mockTurno('RESERVADO');
    mockPrisma.pago.findUnique
      .mockResolvedValueOnce({ estado: 'PENDIENTE', cuponId: null }) // lectura inicial
      .mockResolvedValueOnce({ estado: 'APROBADO' }); // re-lectura post aprobación
    mockSearch.mockResolvedValue({ results: [{ id: 'mp-pay-1', status: 'approved', transaction_amount: 420 }] });
    mockApprove.mockResolvedValue(approvedResult());

    const res = await confirmarPago({ userId, turnoId });

    expect(mockSearch).toHaveBeenCalledWith(turnoId, 'seller-token');
    expect(mockApprove).toHaveBeenCalledWith(turnoId, {
      paymentId: 'mp-pay-1',
      status: 'approved',
      amount: 420,
    });
    expect(mockSendNotification).toHaveBeenCalledWith(
      ['EMAIL', 'WHATSAPP'],
      expect.objectContaining({ event: 'TURNO_CONFIRMADO' }),
    );
    // approvePagoForTurno ya confirmó el turno → no se re-actualiza.
    expect(mockPrisma.turno.update).not.toHaveBeenCalled();
    expect(res).toMatchObject({ confirmed: true, estado: 'APROBADO', turnoEstado: 'CONFIRMADO' });
  });

  it('MP sin pago aprobado → no aprueba, el turno sigue PENDIENTE', async () => {
    mockTurno('RESERVADO');
    mockPrisma.pago.findUnique.mockResolvedValue({ estado: 'PENDIENTE', cuponId: null });
    mockSearch.mockResolvedValue({ results: [{ id: 'mp-pay-1', status: 'pending' }] });

    const res = await confirmarPago({ userId, turnoId });

    expect(mockApprove).not.toHaveBeenCalled();
    expect(mockSendNotification).not.toHaveBeenCalled();
    expect(mockPrisma.turno.update).not.toHaveBeenCalled();
    expect(res).toMatchObject({ confirmed: false, estado: 'PENDIENTE', turnoEstado: 'RESERVADO' });
  });

  it('pago ya APROBADO → no consulta a MP, solo confirma el turno', async () => {
    mockTurno('RESERVADO');
    mockPrisma.pago.findUnique.mockResolvedValue({ estado: 'APROBADO' });

    const res = await confirmarPago({ userId, turnoId });

    expect(mockSearch).not.toHaveBeenCalled();
    expect(mockApprove).not.toHaveBeenCalled();
    expect(mockPrisma.turno.update).toHaveBeenCalledWith({
      where: { id: turnoId },
      data: { estado: 'CONFIRMADO' },
    });
    expect(res).toMatchObject({ confirmed: true, estado: 'APROBADO', turnoEstado: 'CONFIRMADO' });
  });

  it('error de MP → responde sin romper, el pago queda PENDIENTE', async () => {
    mockTurno('RESERVADO');
    mockPrisma.pago.findUnique.mockResolvedValue({ estado: 'PENDIENTE', cuponId: null });
    mockSearch.mockRejectedValue(new Error('MP timeout'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await confirmarPago({ userId, turnoId });

    expect(mockApprove).not.toHaveBeenCalled();
    expect(mockPrisma.turno.update).not.toHaveBeenCalled();
    expect(res).toMatchObject({ confirmed: false, estado: 'PENDIENTE' });
    errorSpy.mockRestore();
  });

  it('carrera con el webhook (approve skipped) → no notifica dos veces pero confirma', async () => {
    mockTurno('RESERVADO');
    mockPrisma.pago.findUnique
      .mockResolvedValueOnce({ estado: 'PENDIENTE', cuponId: null })
      .mockResolvedValueOnce({ estado: 'APROBADO' }); // el webhook ya lo aprobó
    mockSearch.mockResolvedValue({ results: [{ id: 'mp-pay-1', status: 'approved', transaction_amount: 420 }] });
    mockApprove.mockResolvedValue({ skipped: true, turnoEstado: 'CONFIRMADO' });

    const res = await confirmarPago({ userId, turnoId });

    expect(mockApprove).toHaveBeenCalled();
    expect(mockSendNotification).not.toHaveBeenCalled(); // el webhook ya notificó
    expect(mockPrisma.turno.update).toHaveBeenCalled(); // confirma con el pago ya aprobado
    expect(res).toMatchObject({ confirmed: true, estado: 'APROBADO', turnoEstado: 'CONFIRMADO' });
  });

  it('no reconcilia un turno en estado terminal (no pagable)', async () => {
    mockTurno('CANCELADO');
    mockPrisma.pago.findUnique.mockResolvedValue({ estado: 'PENDIENTE', cuponId: null });

    const res = await confirmarPago({ userId, turnoId });

    expect(mockSearch).not.toHaveBeenCalled();
    expect(mockApprove).not.toHaveBeenCalled();
    expect(res).toMatchObject({ confirmed: false, estado: 'PENDIENTE', turnoEstado: 'CANCELADO' });
  });
});
