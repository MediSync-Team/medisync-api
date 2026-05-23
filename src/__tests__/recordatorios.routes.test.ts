import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { generateToken } from '../middleware/auth.middleware';

const profesionalId = '11111111-1111-4111-8111-111111111111';
const profesionalUsuarioId = '22222222-2222-4222-8222-222222222222';
const pacienteId = '33333333-3333-4333-8333-333333333333';
const pacienteUsuarioId = '44444444-4444-4444-8444-444444444444';

const mockPrisma = {
  turno: {
    findMany: jest.fn() as any,
  },
};

jest.mock('../lib/prisma', () => ({
  __esModule: true,
  default: mockPrisma,
}));

jest.mock('../utils/auth-helpers', () => ({
  findProfesionalByUserId: jest.fn(),
  findPacienteByUserId: jest.fn(),
}));

import { recordatoriosRouter } from '../routes/recordatorios.routes';
import { findPacienteByUserId, findProfesionalByUserId } from '../utils/auth-helpers';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/recordatorios', recordatoriosRouter);
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err.statusCode || 500).json({
      success: false,
      error: { code: err.code || 'INTERNAL_ERROR', message: err.message },
    });
  });
  return app;
}

function token(userId: string, rol: 'PROFESIONAL' | 'PACIENTE') {
  return generateToken({
    userId,
    email: `${userId}@test.com`,
    rol,
  });
}

describe('recordatorios routes', () => {
  const app = makeApp();

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockPrisma.turno.findMany.mockResolvedValue([]);
    (findProfesionalByUserId as jest.MockedFunction<typeof findProfesionalByUserId>).mockResolvedValue({
      id: profesionalId,
    } as any);
    (findPacienteByUserId as jest.MockedFunction<typeof findPacienteByUserId>).mockResolvedValue({
      id: pacienteId,
    } as any);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('uses a rolling next-24-hours window for professional reminders', async () => {
    const now = new Date('2026-06-01T02:30:00.000Z');
    const end = new Date('2026-06-02T02:30:00.000Z');
    jest.setSystemTime(now);

    const res = await request(app)
      .get('/recordatorios/profesional')
      .set('Authorization', `Bearer ${token(profesionalUsuarioId, 'PROFESIONAL')}`)
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(200);
    expect(mockPrisma.turno.findMany).toHaveBeenCalledWith({
      where: {
        profesionalId,
        fechaHora: { gte: now, lte: end },
        estado: { in: ['RESERVADO', 'CONFIRMADO'] },
      },
      include: { paciente: true },
      orderBy: { fechaHora: 'asc' },
    });
  });

  it('uses the same rolling next-24-hours window for patient reminders', async () => {
    const now = new Date('2026-06-01T02:30:00.000Z');
    const end = new Date('2026-06-02T02:30:00.000Z');
    jest.setSystemTime(now);

    const res = await request(app)
      .get('/recordatorios/paciente')
      .set('Authorization', `Bearer ${token(pacienteUsuarioId, 'PACIENTE')}`)
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(200);
    expect(mockPrisma.turno.findMany).toHaveBeenCalledWith({
      where: {
        pacienteId,
        fechaHora: { gte: now, lte: end },
        estado: { in: ['RESERVADO', 'CONFIRMADO'] },
      },
      include: {
        profesional: {
          include: { especialidad: true },
        },
      },
      orderBy: { fechaHora: 'asc' },
    });
  });
});
