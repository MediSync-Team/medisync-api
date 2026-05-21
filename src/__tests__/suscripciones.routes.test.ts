import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { generateToken } from '../middleware/auth.middleware';
import { getClinicDateTimeParts, getClinicMonthBounds } from '../utils/clinic-time';

const profesionalId = '11111111-1111-4111-8111-111111111111';
const profesionalUsuarioId = '22222222-2222-4222-8222-222222222222';

const mockPrisma = {
  profesional: {
    findUnique: jest.fn() as any,
    update: jest.fn() as any,
    findFirst: jest.fn() as any,
  },
  turno: {
    count: jest.fn() as any,
  },
};

jest.mock('../lib/prisma', () => ({
  __esModule: true,
  default: mockPrisma,
}));

jest.mock('../utils/auth-helpers', () => ({
  getProfesionalIdByUsuario: jest.fn(async () => profesionalId),
}));

import { suscripcionesRouter } from '../routes/suscripciones.routes';
import { getProfesionalIdByUsuario } from '../utils/auth-helpers';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/suscripciones', suscripcionesRouter);
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
    email: 'doctor@test.com',
    rol: 'PROFESIONAL',
  });
}

describe('GET /suscripciones/estado', () => {
  const app = makeApp();

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockPrisma.profesional.findUnique.mockResolvedValue({
      plan: 'FREE',
      planVenceAt: null,
      mpSuscripcionId: null,
    });
    mockPrisma.turno.count.mockResolvedValue(7);
    (getProfesionalIdByUsuario as jest.MockedFunction<typeof getProfesionalIdByUsuario>).mockResolvedValue(profesionalId);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('counts only active appointments inside the current Argentina month bounds', async () => {
    const now = new Date('2026-05-21T15:00:00.000Z');
    jest.setSystemTime(now);
    const parts = getClinicDateTimeParts(now);
    const { start, end } = getClinicMonthBounds(parts.year, parts.month);

    const res = await request(app)
      .get('/suscripciones/estado')
      .set('Authorization', `Bearer ${profesionalToken()}`)
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(200);
    expect(mockPrisma.turno.count).toHaveBeenCalledWith({
      where: {
        profesionalId,
        fechaHora: { gte: start, lt: end },
        estado: { notIn: ['CANCELADO'] },
      },
    });
    expect(res.body.data).toMatchObject({
      plan: 'FREE',
      turnosEsteMes: 7,
      limiteTurnos: 20,
      turnosRestantes: 13,
    });
  });

  it('uses Argentina month when UTC date is already next month', async () => {
    const now = new Date('2026-06-01T02:30:00.000Z');
    jest.setSystemTime(now);
    const { start, end } = getClinicMonthBounds(2026, 5);

    const res = await request(app)
      .get('/suscripciones/estado')
      .set('Authorization', `Bearer ${profesionalToken()}`)
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(200);
    expect(mockPrisma.turno.count).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        fechaHora: { gte: start, lt: end },
      }),
    }));
  });

  it('never returns negative remaining appointments', async () => {
    mockPrisma.turno.count.mockResolvedValue(23);

    const res = await request(app)
      .get('/suscripciones/estado')
      .set('Authorization', `Bearer ${profesionalToken()}`)
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(200);
    expect(res.body.data.turnosRestantes).toBe(0);
  });
});
