import { describe, expect, it, jest, beforeEach } from '@jest/globals';

const mockPrisma = {
  turno: {
    findMany: jest.fn() as any,
    findUnique: jest.fn() as any,
    updateMany: jest.fn() as any,
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
  const now = new Date('2026-05-21T18:00:00.000Z');

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(now);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should cancel unpaid turnos one hour after the appointment ends', async () => {
    const staleTurnoMock = {
      id: 'turno-stale-1',
      profesionalId: 'prof-1',
      pacienteId: 'pac-1',
      fechaHora: new Date('2026-05-21T16:00:00.000Z'),
      duracionMin: 30,
      modalidad: 'PRESENCIAL',
      estado: 'RESERVADO',
      profesional: {
        precioConsulta: 1500,
      },
      pago: null,
    };

    mockPrisma.turno.findMany.mockResolvedValue([staleTurnoMock]);
    mockPrisma.$transaction.mockImplementation(async (callback: any) => {
      mockPrisma.turno.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.turno.findUnique.mockResolvedValue({ ...staleTurnoMock, estado: 'CANCELADO' });
      return callback(mockPrisma);
    });

    await cleanupStaleReservations();

    expect(mockPrisma.turno.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        fechaHora: { lt: new Date('2026-05-21T17:00:00.000Z') },
      }),
    }));
    expect(mockPrisma.turno.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'turno-stale-1',
        estado: 'RESERVADO',
        OR: [
          { pago: null },
          { pago: { estado: { not: 'APROBADO' } } },
        ],
      },
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

  it('should not cancel an old reservation before the appointment has finished', async () => {
    const futureTurnoMock = {
      id: 'turno-future-1',
      profesionalId: 'prof-1',
      pacienteId: 'pac-1',
      fechaHora: new Date('2026-05-21T20:00:00.000Z'),
      duracionMin: 30,
      modalidad: 'PRESENCIAL',
      estado: 'RESERVADO',
      profesional: {
        precioConsulta: 1500,
      },
      pago: null,
    };

    mockPrisma.turno.findMany.mockResolvedValue([futureTurnoMock]);

    await cleanupStaleReservations();

    expect(mockPrisma.turno.findMany).toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockNotifyWaitlist).not.toHaveBeenCalled();
  });

  it('should not cancel until one hour after the appointment end time', async () => {
    const withinGraceTurnoMock = {
      id: 'turno-grace-1',
      profesionalId: 'prof-1',
      pacienteId: 'pac-1',
      fechaHora: new Date('2026-05-21T16:45:00.000Z'),
      duracionMin: 30,
      modalidad: 'PRESENCIAL',
      estado: 'RESERVADO',
      profesional: {
        precioConsulta: 1500,
      },
      pago: null,
    };

    mockPrisma.turno.findMany.mockResolvedValue([withinGraceTurnoMock]);

    await cleanupStaleReservations();

    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.turno.updateMany).not.toHaveBeenCalled();
    expect(mockNotifyWaitlist).not.toHaveBeenCalled();
  });

  it('should respect custom appointment duration before cleanup eligibility', async () => {
    const longTurnoMock = {
      id: 'turno-long-1',
      profesionalId: 'prof-1',
      pacienteId: 'pac-1',
      fechaHora: new Date('2026-05-21T15:45:00.000Z'),
      duracionMin: 90,
      modalidad: 'PRESENCIAL',
      estado: 'RESERVADO',
      profesional: {
        precioConsulta: 1500,
      },
      pago: null,
    };

    mockPrisma.turno.findMany.mockResolvedValue([longTurnoMock]);

    await cleanupStaleReservations();

    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.turno.updateMany).not.toHaveBeenCalled();
  });

  it('should not cancel if turno status has changed to CONFIRMADO in transaction', async () => {
    const staleTurnoMock = {
      id: 'turno-stale-2',
      profesionalId: 'prof-1',
      pacienteId: 'pac-1',
      fechaHora: new Date('2026-05-21T16:00:00.000Z'),
      duracionMin: 30,
      modalidad: 'PRESENCIAL',
      estado: 'RESERVADO',
      profesional: {
        precioConsulta: 1500,
      },
      pago: null,
    };

    mockPrisma.turno.findMany.mockResolvedValue([staleTurnoMock]);
    mockPrisma.$transaction.mockImplementation(async (callback: any) => {
      mockPrisma.turno.updateMany.mockResolvedValue({ count: 0 });
      return callback(mockPrisma);
    });

    await cleanupStaleReservations();

    expect(mockPrisma.turno.findMany).toHaveBeenCalled();
    expect(mockPrisma.turno.findUnique).not.toHaveBeenCalled();
    expect(mockNotifyWaitlist).not.toHaveBeenCalled();
    expect(mockSyncTurnoCancelled).not.toHaveBeenCalled();
  });

  it('should not cancel if payment became approved before cleanup update', async () => {
    const staleTurnoMock = {
      id: 'turno-stale-paid',
      profesionalId: 'prof-1',
      pacienteId: 'pac-1',
      fechaHora: new Date('2026-05-21T16:00:00.000Z'),
      duracionMin: 30,
      modalidad: 'VIRTUAL',
      estado: 'RESERVADO',
      profesional: {
        precioConsulta: 1500,
      },
      pago: {
        estado: 'PENDIENTE',
      },
    };

    mockPrisma.turno.findMany.mockResolvedValue([staleTurnoMock]);
    mockPrisma.$transaction.mockImplementation(async (callback: any) => {
      mockPrisma.turno.updateMany.mockResolvedValue({ count: 0 });
      return callback(mockPrisma);
    });

    await cleanupStaleReservations();

    expect(mockPrisma.turno.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'turno-stale-paid',
        estado: 'RESERVADO',
        OR: [
          { pago: null },
          { pago: { estado: { not: 'APROBADO' } } },
        ],
      },
      data: {
        estado: 'CANCELADO',
        notasCancelacion: 'Reserva expirada por falta de pago.',
      },
    });
    expect(mockPrisma.turno.findUnique).not.toHaveBeenCalled();
    expect(mockNotifyWaitlist).not.toHaveBeenCalled();
    expect(mockSyncTurnoCancelled).not.toHaveBeenCalled();
    expect(mockSyncTurnoCancelledForPaciente).not.toHaveBeenCalled();
  });

  it('should do nothing if no stale turnos are found', async () => {
    mockPrisma.turno.findMany.mockResolvedValue([]);

    await cleanupStaleReservations();

    expect(mockPrisma.turno.findMany).toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.turno.updateMany).not.toHaveBeenCalled();
  });
});
