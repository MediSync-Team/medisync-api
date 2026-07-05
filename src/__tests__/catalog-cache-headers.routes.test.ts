import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockPrisma = {
  especialidad: {
    findMany: jest.fn() as any,
  },
};

jest.mock('../lib/prisma', () => ({
  __esModule: true,
  default: mockPrisma,
}));

import { especialidadesRouter } from '../routes/especialidades.routes';
import { obrasSocialesRouter } from '../routes/obras-sociales.routes';

describe('catalog routes Cache-Control headers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.especialidad.findMany.mockResolvedValue([{ id: 'e-1', nombre: 'Cardiología' }] as any);
  });

  it('GET /especialidades sets a short public max-age with SWR', async () => {
    const app = express();
    app.use('/especialidades', especialidadesRouter);

    const res = await request(app).get('/especialidades');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300, stale-while-revalidate=86400');
  });

  it('GET /obras-sociales sets a long public max-age (hardcoded list)', async () => {
    const app = express();
    app.use('/obras-sociales', obrasSocialesRouter);

    const res = await request(app).get('/obras-sociales');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=86400, stale-while-revalidate=604800');
  });
});
