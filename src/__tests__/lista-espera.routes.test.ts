import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { generateToken } from '../middleware/auth.middleware';

const pacienteId = '33333333-3333-4333-8333-333333333333';
const pacienteUsuarioId = '44444444-4444-4444-8444-444444444444';
const profesionalId = '11111111-1111-4111-8111-111111111111';

const mockPrisma = {
  listaEspera: {
    findMany: jest.fn() as any,
    findFirst: jest.fn() as any,
    create: jest.fn() as any,
    findUnique: jest.fn() as any,
    update: jest.fn() as any,
  },
  profesional: {
    findUnique: jest.fn() as any,
  },
};

jest.mock('../lib/prisma', () => ({
  __esModule: true,
  default: mockPrisma,
}));

jest.mock('../utils/auth-helpers', () => ({
  findPacienteByUserId: jest.fn(async () => ({ id: pacienteId })),
}));

import { listaEsperaRouter } from '../routes/lista-espera.routes';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/lista-espera', listaEsperaRouter);
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

describe('lista-espera routes', () => {
  const app = makeApp();

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.profesional.findUnique.mockResolvedValue({ id: profesionalId, activo: true });
    mockPrisma.listaEspera.findFirst.mockResolvedValue(null);
    mockPrisma.listaEspera.create.mockImplementation(async ({ data }: any) => ({ id: 'lista-1', ...data }));
  });

  it('stores waitlist fecha as the Argentina clinic date boundary', async () => {
    const res = await request(app)
      .post('/lista-espera/suscribirme')
      .set('Authorization', `Bearer ${pacienteToken()}`)
      .send({ profesionalId, fecha: '2026-05-18', modalidad: 'PRESENCIAL' })
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(201);
    const expectedDate = new Date('2026-05-18T03:00:00.000Z');
    expect(mockPrisma.listaEspera.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ fecha: expectedDate }),
    }));
    expect(mockPrisma.listaEspera.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ fecha: expectedDate }),
    }));
  });

  it('uses the normalized waitlist date for duplicate detection', async () => {
    mockPrisma.listaEspera.findFirst.mockResolvedValue({ id: 'existing-lista' });

    const res = await request(app)
      .post('/lista-espera/suscribirme')
      .set('Authorization', `Bearer ${pacienteToken()}`)
      .send({ profesionalId, fecha: '2026-05-18', modalidad: 'VIRTUAL' })
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_SUBSCRIBED');
    expect(mockPrisma.listaEspera.create).not.toHaveBeenCalled();
  });

  it('rejects invalid waitlist date strings', async () => {
    const res = await request(app)
      .post('/lista-espera/suscribirme')
      .set('Authorization', `Bearer ${pacienteToken()}`)
      .send({ profesionalId, fecha: '2026-02-31', modalidad: 'PRESENCIAL' })
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(mockPrisma.listaEspera.findFirst).not.toHaveBeenCalled();
  });
});
