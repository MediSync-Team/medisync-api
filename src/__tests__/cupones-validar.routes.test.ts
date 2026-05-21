import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { describe, expect, it, beforeEach, jest } from '@jest/globals';
import { generateToken } from '../middleware/auth.middleware';

const mockPrisma = {
  turno: {
    findUnique: jest.fn() as any,
  },
};

jest.mock('../lib/prisma', () => ({
  __esModule: true,
  default: mockPrisma,
}));

const mockValidateAndApplyCoupon = jest.fn() as any;
jest.mock('../utils/coupon', () => ({
  validateAndApplyCoupon: mockValidateAndApplyCoupon,
}));

import { cuponesRouter } from '../routes/cupones.routes';

const pacienteUsuarioId = '22222222-2222-4222-8222-222222222222';
const otroPacienteUsuarioId = '99999999-9999-4999-8999-999999999999';
const turnoId = '33333333-3333-4333-8333-333333333333';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/cupones', cuponesRouter);
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err.statusCode || 500).json({
      success: false,
      error: { code: err.code || 'INTERNAL_ERROR', message: err.message },
    });
  });
  return app;
}

function patientToken() {
  return generateToken({
    userId: pacienteUsuarioId,
    email: 'paciente@test.com',
    rol: 'PACIENTE',
  });
}

function mockTurnoForPaciente(usuarioId: string | null = pacienteUsuarioId) {
  mockPrisma.turno.findUnique.mockResolvedValue({
    id: turnoId,
    profesionalId: 'prof-1',
    paciente: usuarioId ? { usuarioId } : null,
    profesional: {
      id: 'prof-1',
      precioConsulta: 420,
    },
  });
}

describe('POST /cupones/validar ownership', () => {
  const app = makeApp();

  beforeEach(() => {
    jest.clearAllMocks();
    mockValidateAndApplyCoupon.mockResolvedValue({
      cuponId: 'cupon-1',
      tipo: 'PORCENTAJE',
      valor: 10,
      descripcion: '10% off',
      montoOriginal: 420,
      montoDescuento: 42,
      montoFinal: 378,
    });
  });

  it('returns validation error when codigo or turnoId is missing', async () => {
    const res = await request(app)
      .post('/cupones/validar')
      .set('Authorization', `Bearer ${patientToken()}`)
      .send({ codigo: 'PROMO10' })
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    expect(mockPrisma.turno.findUnique).not.toHaveBeenCalled();
    expect(mockValidateAndApplyCoupon).not.toHaveBeenCalled();
  });

  it('returns not found for unknown turno', async () => {
    mockPrisma.turno.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/cupones/validar')
      .set('Authorization', `Bearer ${patientToken()}`)
      .send({ codigo: 'PROMO10', turnoId })
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('NOT_FOUND');
    expect(mockValidateAndApplyCoupon).not.toHaveBeenCalled();
  });

  it('validates coupon for the authenticated patient turno', async () => {
    mockTurnoForPaciente();

    const res = await request(app)
      .post('/cupones/validar')
      .set('Authorization', `Bearer ${patientToken()}`)
      .send({ codigo: 'PROMO10', turnoId })
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ cuponId: 'cupon-1', montoFinal: 378 });
    expect(mockPrisma.turno.findUnique).toHaveBeenCalledWith({
      where: { id: turnoId },
      include: { paciente: true, profesional: true },
    });
    expect(mockValidateAndApplyCoupon).toHaveBeenCalledWith('PROMO10', turnoId, 'prof-1', 420);
  });

  it('forbids coupon validation for another patient turno', async () => {
    mockTurnoForPaciente(otroPacienteUsuarioId);

    const res = await request(app)
      .post('/cupones/validar')
      .set('Authorization', `Bearer ${patientToken()}`)
      .send({ codigo: 'PROMO10', turnoId })
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('FORBIDDEN');
    expect(mockValidateAndApplyCoupon).not.toHaveBeenCalled();
  });

  it('forbids coupon validation for turno without patient profile', async () => {
    mockTurnoForPaciente(null);

    const res = await request(app)
      .post('/cupones/validar')
      .set('Authorization', `Bearer ${patientToken()}`)
      .send({ codigo: 'PROMO10', turnoId })
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('FORBIDDEN');
    expect(mockValidateAndApplyCoupon).not.toHaveBeenCalled();
  });
});
