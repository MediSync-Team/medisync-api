import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { generateToken } from '../middleware/auth.middleware';

const profUsuarioId = '11111111-1111-4111-8111-111111111111';
const profId = '44444444-4444-4444-8444-444444444444';
const pacienteId = '33333333-3333-4333-8333-333333333333';

const mockPrisma = {
  turno: {
    findFirst: jest.fn() as any,
    findMany: jest.fn() as any,
  },
  paciente: {
    findUnique: jest.fn() as any,
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
import { findProfesionalByUserId } from '../utils/auth-helpers';

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

function profToken() {
  return generateToken({ userId: profUsuarioId, email: 'prof@test.com', rol: 'PROFESIONAL' });
}

describe('GET /pacientes/:id/historia-clinica access control (M-A2)', () => {
  const app = makeApp();

  beforeEach(() => {
    jest.clearAllMocks();
    (findProfesionalByUserId as jest.MockedFunction<typeof findProfesionalByUserId>).mockResolvedValue({
      id: profId,
      usuarioId: profUsuarioId,
    } as any);
    mockPrisma.paciente.findUnique.mockResolvedValue({ id: pacienteId, nombre: 'Ada', apellido: 'Lovelace' });
  });

  it('only counts CONFIRMADO/COMPLETADO turnos as a clinical relationship', async () => {
    mockPrisma.turno.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get(`/pacientes/${pacienteId}/historia-clinica`)
      .set('Authorization', `Bearer ${profToken()}`)
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(403);
    expect(mockPrisma.turno.findFirst).toHaveBeenCalledWith({
      where: {
        profesionalId: profId,
        pacienteId,
        estado: { in: ['CONFIRMADO', 'COMPLETADO'] },
      },
      select: { id: true },
    });
  });

  it('denies access when the only shared turno was CANCELADO', async () => {
    // findFirst with the estado filter returns null (the CANCELADO turno is filtered out)
    mockPrisma.turno.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get(`/pacientes/${pacienteId}/historia-clinica`)
      .set('Authorization', `Bearer ${profToken()}`)
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(403);
    expect(mockPrisma.turno.findMany).not.toHaveBeenCalled();
  });

  it('grants access when a CONFIRMADO/COMPLETADO turno exists', async () => {
    mockPrisma.turno.findFirst.mockResolvedValue({ id: 'turno-1' });
    mockPrisma.turno.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get(`/pacientes/${pacienteId}/historia-clinica`)
      .set('Authorization', `Bearer ${profToken()}`)
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(200);
  });
});
