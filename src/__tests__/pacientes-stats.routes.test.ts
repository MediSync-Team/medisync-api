import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { generateToken } from '../middleware/auth.middleware';
import { getClinicDateTimeParts, getClinicMonthBounds } from '../utils/clinic-time';

const pacienteUsuarioId = '22222222-2222-4222-8222-222222222222';
const pacienteId = '33333333-3333-4333-8333-333333333333';

const mockPrisma = {
  turno: {
    groupBy: jest.fn() as any,
    findMany: jest.fn() as any,
    findFirst: jest.fn() as any,
  },
  pago: {
    findMany: jest.fn() as any,
  },
  profesional: {
    findMany: jest.fn() as any,
  },
  paciente: {
    findUnique: jest.fn() as any,
    update: jest.fn() as any,
  },
};

jest.mock('../lib/prisma', () => ({
  __esModule: true,
  default: mockPrisma,
}));

jest.mock('../utils/auth-helpers', () => ({
  findPacienteByUserId: jest.fn(),
  findProfesionalByUserId: jest.fn(),
}));

import { pacientesRouter } from '../routes/pacientes.routes';
import { findPacienteByUserId } from '../utils/auth-helpers';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/pacientes', pacientesRouter);
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err.statusCode || 500).json({
      success: false,
      error: { code: err.code || 'INTERNAL_ERROR', message: err.message },
    });
  });
  return app;
}

function pacienteToken() {
  return generateToken({
    userId: pacienteUsuarioId,
    email: 'paciente@test.com',
    rol: 'PACIENTE',
  });
}

describe('GET /pacientes/mis-stats', () => {
  const app = makeApp();

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    (findPacienteByUserId as jest.MockedFunction<typeof findPacienteByUserId>).mockResolvedValue({
      id: pacienteId,
      usuarioId: pacienteUsuarioId,
    } as any);

    mockPrisma.turno.groupBy
      .mockResolvedValueOnce([
        { estado: 'COMPLETADO', _count: { id: 2 } },
        { estado: 'CANCELADO', _count: { id: 1 } },
      ])
      .mockResolvedValueOnce([]);
    mockPrisma.pago.findMany.mockResolvedValue([]);
    mockPrisma.profesional.findMany.mockResolvedValue([]);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('queries the last 12 Argentina clinic months ending with the current month', async () => {
    const now = new Date('2026-06-01T02:30:00.000Z');
    jest.setSystemTime(now);
    const { start } = getClinicMonthBounds(2025, 6);
    const { end } = getClinicMonthBounds(2026, 5);

    mockPrisma.turno.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get('/pacientes/mis-stats')
      .set('Authorization', `Bearer ${pacienteToken()}`)
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(200);
    expect(getClinicDateTimeParts(now)).toMatchObject({ year: 2026, month: 5 });
    expect(mockPrisma.turno.findMany).toHaveBeenCalledWith({
      where: {
        pacienteId,
        fechaHora: { gte: start, lt: end },
        estado: { notIn: ['CANCELADO'] },
      },
      select: { fechaHora: true, estado: true },
    });
  });

  it('groups appointment instants by Argentina clinic month', async () => {
    jest.setSystemTime(new Date('2026-06-15T15:00:00.000Z'));
    mockPrisma.turno.findMany.mockResolvedValue([
      { fechaHora: new Date('2026-06-01T02:30:00.000Z'), estado: 'CONFIRMADO' },
      { fechaHora: new Date('2026-06-01T03:00:00.000Z'), estado: 'CONFIRMADO' },
      { fechaHora: new Date('2026-06-18T13:00:00.000Z'), estado: 'COMPLETADO' },
    ]);

    const res = await request(app)
      .get('/pacientes/mis-stats')
      .set('Authorization', `Bearer ${pacienteToken()}`)
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(200);
    expect(res.body.data.turnosPorMes).toEqual([
      { mes: '2026-05', total: 1 },
      { mes: '2026-06', total: 2 },
    ]);
  });
});
