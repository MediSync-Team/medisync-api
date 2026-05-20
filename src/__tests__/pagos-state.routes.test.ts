import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { describe, expect, it, beforeEach, jest } from '@jest/globals';
import { generateToken } from '../middleware/auth.middleware';

const mockPrisma = {
  turno: {
    findUnique: jest.fn() as any,
    update: jest.fn() as any,
  },
  pago: {
    findUnique: jest.fn() as any,
    upsert: jest.fn() as any,
  },
  cupon: {
    update: jest.fn() as any,
  },
};

jest.mock('../lib/prisma', () => ({
  __esModule: true,
  default: mockPrisma,
}));

jest.mock('../utils/notifications', () => ({
  sendNotification: jest.fn(async () => undefined),
}));

jest.mock('../utils/coupon', () => ({
  validateAndApplyCoupon: jest.fn(),
}));

import { pagosRouter } from '../routes/pagos.routes';

const pacienteUsuarioId = '22222222-2222-4222-8222-222222222222';
const turnoId = '33333333-3333-4333-8333-333333333333';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/pagos', pagosRouter);
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

function mockTurno(estado: string, precioConsulta = 420) {
  mockPrisma.turno.findUnique.mockResolvedValue({
    id: turnoId,
    estado,
    paciente: { usuarioId: pacienteUsuarioId, email: 'paciente@test.com' },
    profesional: {
      id: 'prof-1',
      nombre: 'Pedro',
      apellido: 'Franchetti',
      precioConsulta,
      especialidad: { nombre: 'Clinica medica' },
    },
    pago: null,
  });
}

describe('payment routes appointment state consistency', () => {
  const app = makeApp();

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.pago.findUnique.mockResolvedValue(null);
    mockPrisma.turno.update.mockResolvedValue({ id: turnoId, estado: 'CONFIRMADO' });
  });

  it('confirms a RESERVADO turno when payment is approved', async () => {
    mockTurno('RESERVADO');
    mockPrisma.pago.findUnique.mockResolvedValue({ estado: 'APROBADO' });

    const res = await request(app)
      .post(`/pagos/confirmar-pago?turnoId=${turnoId}`)
      .set('Authorization', `Bearer ${patientToken()}`)
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      confirmed: true,
      estado: 'APROBADO',
      turnoEstado: 'CONFIRMADO',
    });
    expect(mockPrisma.turno.update).toHaveBeenCalledWith({
      where: { id: turnoId },
      data: { estado: 'CONFIRMADO' },
    });
  });

  it('keeps an already CONFIRMADO turno confirmed when payment is approved', async () => {
    mockTurno('CONFIRMADO');
    mockPrisma.pago.findUnique.mockResolvedValue({ estado: 'APROBADO' });

    const res = await request(app)
      .post(`/pagos/confirmar-pago?turnoId=${turnoId}`)
      .set('Authorization', `Bearer ${patientToken()}`)
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      confirmed: true,
      estado: 'APROBADO',
      turnoEstado: 'CONFIRMADO',
    });
    expect(mockPrisma.turno.update).not.toHaveBeenCalled();
  });

  it.each(['CANCELADO', 'COMPLETADO', 'AUSENTE'] as const)(
    'does not confirm a terminal %s turno even when payment is approved',
    async (estado) => {
      mockTurno(estado);
      mockPrisma.pago.findUnique.mockResolvedValue({ estado: 'APROBADO' });

      const res = await request(app)
        .post(`/pagos/confirmar-pago?turnoId=${turnoId}`)
        .set('Authorization', `Bearer ${patientToken()}`)
        .timeout({ deadline: 1000 });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        confirmed: false,
        estado: 'APROBADO',
        turnoEstado: estado,
      });
      expect(mockPrisma.turno.update).not.toHaveBeenCalled();
    }
  );

  it('auto-confirms a no-price RESERVADO turno when creating a payment preference', async () => {
    mockTurno('RESERVADO', 0);

    const res = await request(app)
      .post('/pagos/crear-preferencia')
      .set('Authorization', `Bearer ${patientToken()}`)
      .send({ turnoId })
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ necesitaPago: false });
    expect(mockPrisma.turno.update).toHaveBeenCalledWith({
      where: { id: turnoId },
      data: { estado: 'CONFIRMADO' },
    });
  });

  it('does not rewrite an already CONFIRMADO no-price turno when creating a payment preference', async () => {
    mockTurno('CONFIRMADO', 0);

    const res = await request(app)
      .post('/pagos/crear-preferencia')
      .set('Authorization', `Bearer ${patientToken()}`)
      .send({ turnoId })
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ necesitaPago: false });
    expect(mockPrisma.turno.update).not.toHaveBeenCalled();
  });

  it('rejects no-price payment preference creation for terminal turnos', async () => {
    mockTurno('CANCELADO', 0);

    const res = await request(app)
      .post('/pagos/crear-preferencia')
      .set('Authorization', `Bearer ${patientToken()}`)
      .send({ turnoId })
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('INVALID_STATE');
    expect(mockPrisma.turno.update).not.toHaveBeenCalled();
  });
});
