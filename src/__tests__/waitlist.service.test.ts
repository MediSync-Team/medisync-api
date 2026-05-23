import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const tx = {
  listaEspera: {
    findFirst: jest.fn() as any,
    update: jest.fn() as any,
    findUnique: jest.fn() as any,
  },
};

const mockPrisma = {
  listaEspera: {
    updateMany: jest.fn() as any,
    findMany: jest.fn() as any,
  },
  $transaction: jest.fn(async (fn: any) => fn(tx)) as any,
};

jest.mock('../lib/prisma', () => ({
  __esModule: true,
  default: mockPrisma,
}));

jest.mock('../utils/notifications', () => ({
  sendNotification: jest.fn(async () => undefined),
}));

jest.mock('../services/notification.service', () => ({
  createNotification: jest.fn(async () => undefined),
}));

import { createNotification } from '../services/notification.service';
import { sendNotification } from '../utils/notifications';
import {
  expireStaleWaitlistNotifications,
  notifyWaitlistForReleasedSlot,
  resolveWaitlistForBooking,
} from '../services/waitlist.service';

describe('waitlist service date matching', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.listaEspera.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.listaEspera.findMany.mockResolvedValue([]);
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(tx));
    tx.listaEspera.findFirst.mockResolvedValue(null);
    tx.listaEspera.update.mockResolvedValue({});
    tx.listaEspera.findUnique.mockResolvedValue(null);
  });

  it('resolves bookings against the appointment Argentina clinic date', async () => {
    await resolveWaitlistForBooking({
      profesionalId: 'prof-1',
      pacienteId: 'pac-1',
      fechaHora: new Date('2026-05-19T02:30:00.000Z'),
      modalidad: 'PRESENCIAL',
    });

    expect(mockPrisma.listaEspera.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        profesionalId: 'prof-1',
        pacienteId: 'pac-1',
        modalidad: 'PRESENCIAL',
        fecha: new Date('2026-05-18T03:00:00.000Z'),
      }),
      data: { estado: 'RESUELTA' },
    });
  });

  it('claims waitlist entries by exact clinic date for released slots', async () => {
    tx.listaEspera.findFirst.mockResolvedValue({ id: 'lista-1' });
    tx.listaEspera.findUnique.mockResolvedValue({
      id: 'lista-1',
      paciente: { email: 'paciente@test.com', telefono: null, usuarioId: 'user-1' },
      profesional: { nombre: 'Ada', apellido: 'Lovelace' },
    });

    await notifyWaitlistForReleasedSlot({
      profesionalId: 'prof-1',
      turnoId: 'turno-1',
      fechaHora: new Date('2026-05-19T02:30:00.000Z'),
      modalidad: 'VIRTUAL',
    });

    expect(tx.listaEspera.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        profesionalId: 'prof-1',
        modalidad: 'VIRTUAL',
        fecha: new Date('2026-05-18T03:00:00.000Z'),
      }),
    }));
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(createNotification).toHaveBeenCalledTimes(1);
  });

  it('cascades stale notifications using the stored date-only value', async () => {
    mockPrisma.listaEspera.findMany.mockResolvedValue([
      {
        id: 'stale-1',
        profesionalId: 'prof-1',
        modalidad: 'PRESENCIAL',
        fecha: new Date('2026-05-18T00:00:00.000Z'),
      },
    ]);
    tx.listaEspera.findFirst.mockResolvedValue({ id: 'next-lista' });
    tx.listaEspera.findUnique.mockResolvedValue({
      id: 'next-lista',
      paciente: { email: 'next@test.com', telefono: null, usuarioId: 'user-2' },
      profesional: { nombre: 'Ada', apellido: 'Lovelace' },
    });

    await expireStaleWaitlistNotifications();

    expect(tx.listaEspera.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        fecha: new Date('2026-05-18T03:00:00.000Z'),
      }),
    }));
  });
});
