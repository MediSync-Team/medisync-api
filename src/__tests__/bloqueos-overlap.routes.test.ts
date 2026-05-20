import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { describe, expect, it, beforeEach, jest } from '@jest/globals';
import { generateToken } from '../middleware/auth.middleware';

const profesionalId = '11111111-1111-4111-8111-111111111111';
const profesionalUsuarioId = '22222222-2222-4222-8222-222222222222';

const mockTx = {
  bloqueoDisponibilidad: {
    create: jest.fn() as any,
  },
  turno: {
    findMany: jest.fn() as any,
    update: jest.fn() as any,
  },
  auditoriaDisponibilidad: {
    create: jest.fn() as any,
  },
};

const mockPrisma = {
  $transaction: jest.fn() as any,
  bloqueoDisponibilidad: {
    findMany: jest.fn() as any,
    findUnique: jest.fn() as any,
    delete: jest.fn() as any,
  },
  auditoriaDisponibilidad: {
    create: jest.fn() as any,
  },
};

jest.mock('../lib/prisma', () => ({
  __esModule: true,
  default: mockPrisma,
}));

jest.mock('../utils/auth-helpers', () => ({
  findProfesionalByUserId: jest.fn(async () => ({ id: profesionalId })),
}));

jest.mock('../utils/notifications', () => ({
  sendNotification: jest.fn(async () => undefined),
  resolveChannels: jest.fn(() => []),
}));

jest.mock('../services/notification.service', () => ({
  createNotification: jest.fn(async () => undefined),
}));

import { bloqueosRouter } from '../routes/bloqueos.routes';
import { clinicDateTimeToUtcDate } from '../utils/clinic-time';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/bloqueos', bloqueosRouter);
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err.statusCode || 500).json({
      success: false,
      error: { code: err.code || 'INTERNAL_ERROR', message: err.message },
    });
  });
  return app;
}

function profesionalToken() {
  return generateToken({
    userId: profesionalUsuarioId,
    email: 'doc@test.com',
    rol: 'PROFESIONAL',
  });
}

describe('POST /bloqueos partial overlap cancellation', () => {
  const app = makeApp();

  beforeEach(() => {
    jest.clearAllMocks();
    mockTx.bloqueoDisponibilidad.create.mockResolvedValue({
      id: 'bloqueo-1',
      profesionalId,
      fechaInicio: new Date('2026-05-18T03:00:00.000Z'),
      fechaFin: new Date('2026-05-18T03:00:00.000Z'),
      horaInicio: '10:15',
      horaFin: '10:45',
    });
    mockTx.auditoriaDisponibilidad.create.mockResolvedValue({ id: 'audit-1' });
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockTx));
  });

  it('cancels appointments that partially overlap the new block', async () => {
    mockTx.turno.findMany.mockResolvedValue([
      {
        id: 'turno-overlap',
        profesionalId,
        pacienteId: 'pac-1',
        fechaHora: clinicDateTimeToUtcDate('2026-05-18', '10:00'),
        duracionMin: 30,
        paciente: { usuarioId: 'user-pac-1', email: 'pac@test.com', notifEmail: true, notifWhatsapp: false },
        profesional: { usuario: { email: 'doc@test.com' } },
      },
      {
        id: 'turno-adjacent',
        profesionalId,
        pacienteId: 'pac-2',
        fechaHora: clinicDateTimeToUtcDate('2026-05-18', '10:45'),
        duracionMin: 30,
        paciente: { usuarioId: 'user-pac-2', email: 'pac2@test.com', notifEmail: true, notifWhatsapp: false },
        profesional: { usuario: { email: 'doc@test.com' } },
      },
    ]);
    mockTx.turno.update.mockResolvedValue({ id: 'turno-overlap', estado: 'CANCELADO' });

    const res = await request(app)
      .post('/bloqueos')
      .set('Authorization', `Bearer ${profesionalToken()}`)
      .send({
        fechaInicio: '2026-05-18',
        fechaFin: '2026-05-18',
        horaInicio: '10:15',
        horaFin: '10:45',
        motivo: 'Guardia',
      })
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(201);
    expect(mockTx.turno.update).toHaveBeenCalledTimes(1);
    expect(mockTx.turno.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'turno-overlap' },
      data: expect.objectContaining({ estado: 'CANCELADO' }),
    }));
  });
});
