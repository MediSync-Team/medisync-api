import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { generateToken } from '../middleware/auth.middleware';

const mockPrisma = {
  clinica: {
    findUnique: jest.fn() as any,
  },
  turno: {
    findMany: jest.fn() as any,
  },
};

jest.mock('../lib/prisma', () => ({
  __esModule: true,
  default: mockPrisma,
}));

jest.mock('../utils/notifications', () => ({
  sendNotification: jest.fn(async () => undefined),
}));

import { clinicasRouter } from '../routes/clinicas.routes';

const clinicUserId = '11111111-1111-4111-8111-111111111111';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/clinicas', clinicasRouter);
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err.statusCode || 500).json({
      success: false,
      error: {
        code: err.code || 'INTERNAL_ERROR',
        message: err.message,
      },
    });
  });
  return app;
}

describe('clinic agenda route timezone handling', () => {
  const app = makeApp();
  const clinicToken = generateToken({
    userId: clinicUserId,
    email: 'clinic@test.com',
    rol: 'CLINICA',
  });

  beforeEach(() => {
    mockPrisma.clinica.findUnique.mockReset();
    mockPrisma.turno.findMany.mockReset();
    mockPrisma.clinica.findUnique.mockResolvedValue({ id: 'clinic-1', usuarioId: clinicUserId });
    mockPrisma.turno.findMany.mockResolvedValue([]);
  });

  it('queries agenda with Argentina day bounds for the selected date', async () => {
    await request(app)
      .get('/clinicas/me/agenda?fecha=2026-05-18')
      .set('Authorization', `Bearer ${clinicToken}`)
      .expect(200);

    expect(mockPrisma.turno.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        fechaHora: {
          gte: new Date('2026-05-18T03:00:00.000Z'),
          lt: new Date('2026-05-19T03:00:00.000Z'),
        },
      }),
    }));
  });

  it('includes late-night Argentina appointments in the previous clinic date', async () => {
    const lateNightTurno = { id: 'turno-1', fechaHora: new Date('2026-05-19T02:30:00.000Z') };
    mockPrisma.turno.findMany.mockImplementation(async ({ where }: any) => {
      const appointmentTime = lateNightTurno.fechaHora.getTime();
      return appointmentTime >= where.fechaHora.gte.getTime() && appointmentTime < where.fechaHora.lt.getTime()
        ? [lateNightTurno]
        : [];
    });

    const may18 = await request(app)
      .get('/clinicas/me/agenda?fecha=2026-05-18')
      .set('Authorization', `Bearer ${clinicToken}`)
      .expect(200);
    const may19 = await request(app)
      .get('/clinicas/me/agenda?fecha=2026-05-19')
      .set('Authorization', `Bearer ${clinicToken}`)
      .expect(200);

    expect(may18.body.data).toHaveLength(1);
    expect(may19.body.data).toHaveLength(0);
  });

  it('rejects invalid agenda dates', async () => {
    const res = await request(app)
      .get('/clinicas/me/agenda?fecha=18-05-2026')
      .set('Authorization', `Bearer ${clinicToken}`)
      .expect(400);

    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    expect(mockPrisma.turno.findMany).not.toHaveBeenCalled();
  });

  // Regression: the web client's month calendar (getClinicMonthFetchBounds)
  // sends desde/hasta as absolute ISO instants, not clinic date-keys — this
  // used to be rejected with a 400 because the range branch re-parsed them
  // with the strict YYYY-MM-DD date-key parser.
  it('accepts a desde/hasta ISO instant range from the month calendar', async () => {
    await request(app)
      .get('/clinicas/me/agenda?desde=2026-05-01T03:00:00.000Z&hasta=2026-07-01T03:00:00.000Z')
      .set('Authorization', `Bearer ${clinicToken}`)
      .expect(200);

    expect(mockPrisma.turno.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        fechaHora: {
          gte: new Date('2026-05-01T03:00:00.000Z'),
          lt: new Date('2026-07-01T03:00:00.000Z'),
        },
      }),
    }));
  });

  it('rejects a desde/hasta range spanning more than 62 days', async () => {
    const res = await request(app)
      .get('/clinicas/me/agenda?desde=2026-01-01T03:00:00.000Z&hasta=2026-12-01T03:00:00.000Z')
      .set('Authorization', `Bearer ${clinicToken}`)
      .expect(400);

    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    expect(mockPrisma.turno.findMany).not.toHaveBeenCalled();
  });
});
