import { describe, expect, it, jest, beforeEach } from '@jest/globals';

const mockPrisma = {
  turno: {
    findMany: jest.fn() as any,
    findUnique: jest.fn() as any,
    update: jest.fn() as any,
  },
  $transaction: jest.fn() as any,
};

jest.mock('../lib/prisma', () => ({
  __esModule: true,
  default: mockPrisma,
}));

const mockNotifyWaitlist = jest.fn(async (_params: any) => undefined);
jest.mock('../services/waitlist.service', () => ({
  notifyWaitlistForReleasedSlot: mockNotifyWaitlist,
}));

const mockSyncTurnoCancelled = jest.fn((_id: string) => Promise.resolve());
const mockSyncTurnoCancelledForPaciente = jest.fn((_id: string) => Promise.resolve());
jest.mock('../services/calendar-sync.service', () => ({
  syncTurnoCancelled: mockSyncTurnoCancelled,
  syncTurnoCancelledForPaciente: mockSyncTurnoCancelledForPaciente,
}));

import { cleanupStaleReservations } from '../services/appointment-cleanup.service';

describe('Appointment Cleanup Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should find stale turnos and cancel them successfully', async () => {
    const staleTurnoMock = {
      id: 'turno-stale-1',
      profesionalId: 'prof-1',
      pacienteId: 'pac-1',
      fechaHora: new Date(),
      modalidad: 'PRESENCIAL',
      estado: 'RESERVADO',
      profesional: {
        precioConsulta: 1500,
      },
      pago: null,
    };

    mockPrisma.turno.findMany.mockResolvedValue([staleTurnoMock]);
    mockPrisma.$transaction.mockImplementation(async (callback: any) => {
      mockPrisma.turno.findUnique.mockResolvedValue({ estado: 'RESERVADO' });
      mockPrisma.turno.update.mockResolvedValue({ ...staleTurnoMock, estado: 'CANCELADO' });
      return callback(mockPrisma);
    });

    await cleanupStaleReservations();

    expect(mockPrisma.turno.findMany).toHaveBeenCalled();
    expect(mockPrisma.turno.update).toHaveBeenCalledWith({
      where: { id: 'turno-stale-1' },
      data: {
        estado: 'CANCELADO',
        notasCancelacion: 'Reserva expirada por falta de pago.',
      },
    });

    expect(mockNotifyWaitlist).toHaveBeenCalledWith({
      profesionalId: 'prof-1',
      fechaHora: staleTurnoMock.fechaHora,
      modalidad: 'PRESENCIAL',
      turnoId: 'turno-stale-1',
    });

    expect(mockSyncTurnoCancelled).toHaveBeenCalledWith('turno-stale-1');
    expect(mockSyncTurnoCancelledForPaciente).toHaveBeenCalledWith('turno-stale-1');
  });

  it('should not cancel if turno status has changed to CONFIRMADO in transaction', async () => {
    const staleTurnoMock = {
      id: 'turno-stale-2',
      profesionalId: 'prof-1',
      pacienteId: 'pac-1',
      fechaHora: new Date(),
      modalidad: 'PRESENCIAL',
      estado: 'RESERVADO',
      profesional: {
        precioConsulta: 1500,
      },
      pago: null,
    };

    mockPrisma.turno.findMany.mockResolvedValue([staleTurnoMock]);
    mockPrisma.$transaction.mockImplementation(async (callback: any) => {
      mockPrisma.turno.findUnique.mockResolvedValue({ estado: 'CONFIRMADO' }); // Changed status
      return callback(mockPrisma);
    });

    await cleanupStaleReservations();

    expect(mockPrisma.turno.findMany).toHaveBeenCalled();
    expect(mockPrisma.turno.update).not.toHaveBeenCalled();
    expect(mockNotifyWaitlist).not.toHaveBeenCalled();
    expect(mockSyncTurnoCancelled).not.toHaveBeenCalled();
  });

  it('should do nothing if no stale turnos are found', async () => {
    mockPrisma.turno.findMany.mockResolvedValue([]);

    await cleanupStaleReservations();

    expect(mockPrisma.turno.findMany).toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.turno.update).not.toHaveBeenCalled();
  });
});
