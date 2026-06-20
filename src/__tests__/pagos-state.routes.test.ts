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
    create: jest.fn() as any,
    findUnique: jest.fn() as any,
    update: jest.fn() as any,
    upsert: jest.fn() as any,
  },
  cupon: {
    findUnique: jest.fn() as any,
    update: jest.fn() as any,
    updateMany: jest.fn() as any,
  },
  $transaction: jest.fn() as any,
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
import { validateAndApplyCoupon } from '../utils/coupon';

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
    profesionalId: 'prof-1',
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
    (validateAndApplyCoupon as jest.MockedFunction<typeof validateAndApplyCoupon>).mockReset();
    mockPrisma.pago.findUnique.mockResolvedValue(null);
    mockPrisma.pago.create.mockResolvedValue({ id: 'pago-1', estado: 'PENDIENTE' });
    mockPrisma.pago.update.mockResolvedValue({ id: 'pago-1', estado: 'PENDIENTE' });
    mockPrisma.turno.update.mockResolvedValue({ id: turnoId, estado: 'CONFIRMADO' });
    mockPrisma.pago.upsert.mockResolvedValue({ id: 'pago-1', estado: 'APROBADO' });
    mockPrisma.cupon.findUnique.mockResolvedValue({ id: 'cupon-1', maxUsos: null, usosActuales: 0 });
    mockPrisma.cupon.update.mockResolvedValue({ id: 'cupon-1' });
    mockPrisma.cupon.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
    (global as any).fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ id: 'mp-pref-1', init_point: 'https://mp.test/checkout' }),
      status: 200,
    }));
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
    expect(res.body.data).toMatchObject({ necesitaPago: false, estado: 'APROBADO' });
    expect(mockPrisma.pago.upsert).toHaveBeenCalledWith({
      where: { turnoId },
      update: expect.objectContaining({
        monto: 0,
        montoNeto: 0,
        estado: 'APROBADO',
      }),
      create: expect.objectContaining({
        turnoId,
        monto: 0,
        montoNeto: 0,
        estado: 'APROBADO',
      }),
    });
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
    expect(mockPrisma.pago.upsert).toHaveBeenCalledWith({
      where: { turnoId },
      update: expect.objectContaining({ estado: 'APROBADO' }),
      create: expect.objectContaining({ estado: 'APROBADO' }),
    });
    expect(mockPrisma.turno.update).not.toHaveBeenCalled();
  });

  it('confirms a RESERVADO turno with an approved zero-total coupon without creating a Mercado Pago preference', async () => {
    mockTurno('RESERVADO', 420);
    (validateAndApplyCoupon as jest.MockedFunction<typeof validateAndApplyCoupon>).mockResolvedValue({
      cuponId: 'cupon-1',
      tipo: 'PORCENTAJE',
      valor: 100,
      descripcion: '100% off',
      montoOriginal: 420,
      montoDescuento: 420,
      montoFinal: 0,
    });
    const fetchSpy = jest.spyOn(global as any, 'fetch').mockImplementation(jest.fn());

    const res = await request(app)
      .post('/pagos/crear-preferencia')
      .set('Authorization', `Bearer ${patientToken()}`)
      .send({ turnoId, cuponCodigo: 'FREE100' })
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      necesitaPago: false,
      estado: 'APROBADO',
    });
    expect(validateAndApplyCoupon).toHaveBeenCalledWith('FREE100', turnoId, 'prof-1', 420);
    expect(mockPrisma.pago.upsert).toHaveBeenCalledWith({
      where: { turnoId },
      update: expect.objectContaining({
        monto: 0,
        montoNeto: 0,
        estado: 'APROBADO',
        cuponId: 'cupon-1',
        montoDescuento: 420,
      }),
      create: expect.objectContaining({
        turnoId,
        monto: 0,
        montoNeto: 0,
        estado: 'APROBADO',
        cuponId: 'cupon-1',
        montoDescuento: 420,
      }),
    });
    expect(mockPrisma.cupon.update).toHaveBeenCalledWith({
      where: { id: 'cupon-1' },
      data: { usosActuales: { increment: 1 } },
    });
    expect(mockPrisma.turno.update).toHaveBeenCalledWith({
      where: { id: turnoId },
      data: { estado: 'CONFIRMADO' },
    });
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it('does not increment coupon usage again when zero-total payment is already approved', async () => {
    mockTurno('CONFIRMADO', 420);
    mockPrisma.turno.findUnique.mockResolvedValue({
      id: turnoId,
      estado: 'CONFIRMADO',
      paciente: { usuarioId: pacienteUsuarioId, email: 'paciente@test.com' },
      profesional: {
        id: 'prof-1',
        nombre: 'Pedro',
        apellido: 'Franchetti',
        precioConsulta: 420,
        especialidad: { nombre: 'Clinica medica' },
      },
      pago: { estado: 'APROBADO', cuponId: 'cupon-1' },
    });

    const res = await request(app)
      .post('/pagos/crear-preferencia')
      .set('Authorization', `Bearer ${patientToken()}`)
      .send({ turnoId, cuponCodigo: 'FREE100' })
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ necesitaPago: false });
    expect(validateAndApplyCoupon).not.toHaveBeenCalled();
    expect(mockPrisma.pago.upsert).not.toHaveBeenCalled();
    expect(mockPrisma.cupon.update).not.toHaveBeenCalled();
    expect(mockPrisma.turno.update).not.toHaveBeenCalled();
  });

  it('rejects zero-total coupon confirmation when capacity is exhausted at redemption time', async () => {
    mockTurno('RESERVADO', 420);
    (validateAndApplyCoupon as jest.MockedFunction<typeof validateAndApplyCoupon>).mockResolvedValue({
      cuponId: 'cupon-1',
      tipo: 'PORCENTAJE',
      valor: 100,
      descripcion: '100% off',
      montoOriginal: 420,
      montoDescuento: 420,
      montoFinal: 0,
    });
    mockPrisma.cupon.findUnique.mockResolvedValue({ id: 'cupon-1', maxUsos: 1, usosActuales: 1 });

    const res = await request(app)
      .post('/pagos/crear-preferencia')
      .set('Authorization', `Bearer ${patientToken()}`)
      .send({ turnoId, cuponCodigo: 'FREE100' })
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('COUPON_EXHAUSTED');
    expect(mockPrisma.pago.upsert).not.toHaveBeenCalled();
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

  it('creates pending payment when creating a paid Mercado Pago preference with no existing payment', async () => {
    mockTurno('RESERVADO', 420);

    const res = await request(app)
      .post('/pagos/crear-preferencia')
      .set('Authorization', `Bearer ${patientToken()}`)
      .send({ turnoId })
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      necesitaPago: true,
      preferenciaId: 'mp-pref-1',
      initPoint: 'https://mp.test/checkout',
      estado: 'PENDIENTE',
    });
    // The pago row is reserved as PENDIENTE BEFORE the MP call (no preference id yet)...
    expect(mockPrisma.pago.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        turnoId,
        monto: 420,
        montoNeto: 420,
        estado: 'PENDIENTE',
      }),
    });
    // ...then the preference id is attached once MP responds.
    expect(mockPrisma.pago.update).toHaveBeenCalledWith({
      where: { turnoId },
      data: { mpPreferenciaId: 'mp-pref-1' },
    });
  });

  it('updates non-approved payment when creating a new paid Mercado Pago preference', async () => {
    mockTurno('RESERVADO', 420);
    mockPrisma.pago.findUnique.mockResolvedValue({ id: 'pago-1', estado: 'PENDIENTE' });

    const res = await request(app)
      .post('/pagos/crear-preferencia')
      .set('Authorization', `Bearer ${patientToken()}`)
      .send({ turnoId })
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ necesitaPago: true });
    // Reservation update (PENDIENTE, no preference id yet)...
    expect(mockPrisma.pago.update).toHaveBeenCalledWith({
      where: { turnoId },
      data: expect.objectContaining({
        monto: 420,
        montoNeto: 420,
        estado: 'PENDIENTE',
      }),
    });
    // ...and the later preference-id attach.
    expect(mockPrisma.pago.update).toHaveBeenCalledWith({
      where: { turnoId },
      data: { mpPreferenciaId: 'mp-pref-1' },
    });
    expect(mockPrisma.pago.create).not.toHaveBeenCalled();
  });

  it('does not overwrite payment if it becomes approved before paid preference persistence', async () => {
    mockTurno('RESERVADO', 420);
    mockPrisma.pago.findUnique.mockResolvedValue({ id: 'pago-1', estado: 'APROBADO' });

    const res = await request(app)
      .post('/pagos/crear-preferencia')
      .set('Authorization', `Bearer ${patientToken()}`)
      .send({ turnoId })
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      necesitaPago: false,
    });
    expect(mockPrisma.pago.create).not.toHaveBeenCalled();
    expect(mockPrisma.pago.update).not.toHaveBeenCalled();
    expect(mockPrisma.pago.upsert).not.toHaveBeenCalled();
  });
});
