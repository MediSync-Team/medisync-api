import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { generateToken } from '../middleware/auth.middleware';
import { getClinicMonthBounds } from '../utils/clinic-time';

const adminUsuarioId = '11111111-1111-4111-8111-111111111111';

const mockPrisma = {
  usuario: {
    count: jest.fn() as any,
    findMany: jest.fn() as any,
  },
  profesional: {
    count: jest.fn() as any,
    findMany: jest.fn() as any,
    update: jest.fn() as any,
  },
  paciente: {
    count: jest.fn() as any,
  },
  turno: {
    count: jest.fn() as any,
    groupBy: jest.fn() as any,
    findMany: jest.fn() as any,
  },
  especialidad: {
    count: jest.fn() as any,
    findFirst: jest.fn() as any,
    findUnique: jest.fn() as any,
    create: jest.fn() as any,
    update: jest.fn() as any,
    delete: jest.fn() as any,
  },
  resena: {
    count: jest.fn() as any,
    groupBy: jest.fn() as any,
  },
  pago: {
    aggregate: jest.fn() as any,
    findMany: jest.fn() as any,
    groupBy: jest.fn() as any,
  },
};

jest.mock('../lib/prisma', () => ({
  __esModule: true,
  default: mockPrisma,
}));

import { adminRouter } from '../routes/admin.routes';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/admin', adminRouter);
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err.statusCode || 500).json({
      success: false,
      error: { code: err.code || 'INTERNAL_ERROR', message: err.message },
    });
  });
  return app;
}

function adminToken() {
  return generateToken({
    userId: adminUsuarioId,
    email: 'admin@test.com',
    rol: 'ADMIN',
  });
}

describe('GET /admin/analytics', () => {
  const app = makeApp();

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockPrisma.pago.findMany.mockResolvedValue([]);
    mockPrisma.turno.findMany.mockResolvedValue([]);
    mockPrisma.turno.groupBy.mockResolvedValue([]);
    mockPrisma.profesional.findMany.mockResolvedValue([]);
    mockPrisma.pago.groupBy.mockResolvedValue([]);
    mockPrisma.turno.count.mockResolvedValue(0);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('uses Argentina clinic month bounds for monthly analytics queries', async () => {
    const now = new Date('2026-06-01T02:30:00.000Z');
    jest.setSystemTime(now);
    const { start } = getClinicMonthBounds(2025, 6);
    const { end } = getClinicMonthBounds(2026, 5);

    const res = await request(app)
      .get('/admin/analytics')
      .set('Authorization', `Bearer ${adminToken()}`)
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(200);
    expect(mockPrisma.pago.findMany).toHaveBeenCalledWith({
      where: { estado: 'APROBADO', createdAt: { gte: start, lt: end } },
      select: { monto: true, createdAt: true },
    });
    expect(mockPrisma.turno.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { createdAt: { gte: start, lt: end } },
      select: { createdAt: true },
    }));
  });

  it('groups revenue and appointment records by Argentina clinic month', async () => {
    jest.setSystemTime(new Date('2026-06-15T15:00:00.000Z'));
    mockPrisma.pago.findMany.mockResolvedValue([
      { monto: 1000, createdAt: new Date('2026-06-01T02:30:00.000Z') },
      { monto: 2000, createdAt: new Date('2026-06-01T03:00:00.000Z') },
      { monto: 500, createdAt: new Date('2024-01-01T12:00:00.000Z') },
    ]);
    mockPrisma.turno.findMany
      .mockResolvedValueOnce([
        { createdAt: new Date('2026-06-01T02:30:00.000Z') },
        { createdAt: new Date('2026-06-01T03:00:00.000Z') },
        { createdAt: new Date('2024-01-01T12:00:00.000Z') },
      ])
      .mockResolvedValueOnce([]);

    const res = await request(app)
      .get('/admin/analytics')
      .set('Authorization', `Bearer ${adminToken()}`)
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(200);
    expect(res.body.data.revenueByMonth).toEqual(expect.arrayContaining([
      { month: '2026-05', revenue: 1000 },
      { month: '2026-06', revenue: 2000 },
    ]));
    expect(res.body.data.turnosByMonth).toEqual(expect.arrayContaining([
      { month: '2026-05', count: 1 },
      { month: '2026-06', count: 1 },
    ]));
  });
});
