import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { describe, expect, it, beforeEach, afterEach, jest } from '@jest/globals';

const mockPrisma = {
  turno: {
    findUnique: jest.fn() as any,
    update: jest.fn() as any,
  },
  pago: {
    create: jest.fn() as any,
    findUnique: jest.fn() as any,
    updateMany: jest.fn() as any,
  },
  cupon: {
    update: jest.fn() as any,
  },
  $transaction: jest.fn() as any,
};

jest.mock('../lib/prisma', () => ({
  __esModule: true,
  default: mockPrisma,
}));

const mockSendNotification = jest.fn(async () => undefined);
jest.mock('../utils/notifications', () => ({
  sendNotification: mockSendNotification,
}));

jest.mock('../utils/coupon', () => ({
  validateAndApplyCoupon: jest.fn(),
}));

import { pagosRouter } from '../routes/pagos.routes';

const turnoId = 'turno-123';
const paymentId = 'mp-payment-123';

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

function mockApprovedPayment() {
  (global as any).fetch = jest.fn(async () => ({
    json: async () => ({
      external_reference: turnoId,
      status: 'approved',
      transaction_amount: 420,
    }),
  }));
}

function makeTurno(estado: 'RESERVADO' | 'CONFIRMADO' | 'CANCELADO' | 'COMPLETADO' | 'AUSENTE', pago: any = null) {
  return {
    id: turnoId,
    estado,
    pago,
    fechaHora: new Date('2026-05-18T13:00:00.000Z'),
    modalidad: 'PRESENCIAL',
    paciente: {
      email: 'paciente@test.com',
      telefono: null,
    },
    profesional: {
      nombre: 'Pedro',
      apellido: 'Franchetti',
      lugarAtencion: 'Consultorio',
    },
  };
}

function mockUpdatedTurno(estado: 'RESERVADO' | 'CONFIRMADO' = 'CONFIRMADO') {
  mockPrisma.turno.update.mockResolvedValue({
    id: turnoId,
    estado,
    fechaHora: new Date('2026-05-18T13:00:00.000Z'),
    modalidad: 'PRESENCIAL',
    paciente: {
      email: 'paciente@test.com',
      telefono: null,
    },
    profesional: {
      nombre: 'Pedro',
      apellido: 'Franchetti',
      lugarAtencion: 'Consultorio',
    },
  });
}

async function postApprovedWebhook(app: ReturnType<typeof makeApp>) {
  return request(app)
    .post('/pagos/webhook')
    .send({ type: 'payment', data: { id: paymentId } })
    .timeout({ deadline: 1000 });
}

describe('POST /pagos/webhook payment approval state guards', () => {
  const app = makeApp();
  let warnSpy: jest.SpiedFunction<typeof console.warn>;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.MP_WEBHOOK_SECRET;
    mockApprovedPayment();
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
    mockPrisma.pago.create.mockResolvedValue({ id: 'pago-1', cuponId: null });
    mockPrisma.pago.findUnique.mockResolvedValue({ id: 'pago-1', cuponId: null, estado: 'APROBADO' });
    mockPrisma.pago.updateMany.mockResolvedValue({ count: 1 });
    mockUpdatedTurno();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('approves payment and confirms a RESERVADO turno', async () => {
    mockPrisma.turno.findUnique.mockResolvedValue(makeTurno('RESERVADO', {
      id: 'pago-1',
      turnoId,
      estado: 'PENDIENTE',
      cuponId: null,
    }));

    const res = await postApprovedWebhook(app);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { received: true } });
    expect(mockPrisma.pago.updateMany).toHaveBeenCalledWith({
      where: { turnoId, estado: { not: 'APROBADO' } },
      data: expect.objectContaining({ estado: 'APROBADO', mpPaymentId: paymentId }),
    });
    expect(mockPrisma.pago.findUnique).toHaveBeenCalledWith({
      where: { turnoId },
    });
    expect(mockPrisma.turno.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: turnoId },
      data: { estado: 'CONFIRMADO' },
    }));
    expect(mockSendNotification).toHaveBeenCalled();
  });

  it('approves payment for an already CONFIRMADO turno and keeps it confirmed', async () => {
    mockPrisma.turno.findUnique.mockResolvedValue(makeTurno('CONFIRMADO', {
      id: 'pago-1',
      turnoId,
      estado: 'PENDIENTE',
      cuponId: null,
    }));
    mockUpdatedTurno('CONFIRMADO');

    const res = await postApprovedWebhook(app);

    expect(res.status).toBe(200);
    expect(mockPrisma.pago.updateMany).toHaveBeenCalled();
    expect(mockPrisma.turno.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { estado: 'CONFIRMADO' },
    }));
  });

  it('creates an approved payment when no payment row exists yet', async () => {
    mockPrisma.turno.findUnique.mockResolvedValue(makeTurno('RESERVADO', null));
    mockPrisma.pago.create.mockResolvedValue({ id: 'pago-created', cuponId: null });

    const res = await postApprovedWebhook(app);

    expect(res.status).toBe(200);
    expect(mockPrisma.pago.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        turnoId,
        monto: 420,
        montoNeto: 420,
        estado: 'APROBADO',
        mpPaymentId: paymentId,
      }),
    });
    expect(mockPrisma.turno.update).toHaveBeenCalled();
    expect(mockSendNotification).toHaveBeenCalledTimes(1);
  });

  it('ignores duplicate approved webhooks when the payment is already approved', async () => {
    mockPrisma.turno.findUnique.mockResolvedValue(makeTurno('CONFIRMADO', {
      id: 'pago-1',
      turnoId,
      estado: 'APROBADO',
      cuponId: 'cupon-1',
    }));

    const res = await postApprovedWebhook(app);

    expect(res.status).toBe(200);
    expect(mockPrisma.pago.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.pago.create).not.toHaveBeenCalled();
    expect(mockPrisma.turno.update).not.toHaveBeenCalled();
    expect(mockPrisma.cupon.update).not.toHaveBeenCalled();
    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  it('increments coupon usage only when the payment newly transitions to approved', async () => {
    mockPrisma.turno.findUnique.mockResolvedValue(makeTurno('RESERVADO', {
      id: 'pago-1',
      turnoId,
      estado: 'PENDIENTE',
      cuponId: 'cupon-1',
    }));
    mockPrisma.pago.findUnique.mockResolvedValue({ id: 'pago-1', cuponId: 'cupon-1', estado: 'APROBADO' });

    const res = await postApprovedWebhook(app);

    expect(res.status).toBe(200);
    expect(mockPrisma.cupon.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.cupon.update).toHaveBeenCalledWith({
      where: { id: 'cupon-1' },
      data: { usosActuales: { increment: 1 } },
    });
  });

  it('does not run side effects when a concurrent approval already won the conditional update', async () => {
    mockPrisma.turno.findUnique.mockResolvedValue(makeTurno('RESERVADO', {
      id: 'pago-1',
      turnoId,
      estado: 'PENDIENTE',
      cuponId: 'cupon-1',
    }));
    mockPrisma.pago.updateMany.mockResolvedValue({ count: 0 });

    const res = await postApprovedWebhook(app);

    expect(res.status).toBe(200);
    expect(mockPrisma.turno.update).not.toHaveBeenCalled();
    expect(mockPrisma.cupon.update).not.toHaveBeenCalled();
    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  it.each(['CANCELADO', 'COMPLETADO', 'AUSENTE'] as const)(
    'ignores approved payments for %s turnos without approving revenue',
    async (estado) => {
      mockPrisma.turno.findUnique.mockResolvedValue(makeTurno(estado));

      const res = await postApprovedWebhook(app);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, data: { received: true } });
      expect(mockPrisma.pago.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.pago.create).not.toHaveBeenCalled();
      expect(mockPrisma.turno.update).not.toHaveBeenCalled();
      expect(mockPrisma.cupon.update).not.toHaveBeenCalled();
      expect(mockSendNotification).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        '[pagos] Ignoring approved payment for non-payable turno',
        expect.objectContaining({ turnoId, turnoEstado: estado, mpPaymentId: paymentId })
      );
    }
  );

  it('ignores approved payments for missing turnos without storing approved payment', async () => {
    mockPrisma.turno.findUnique.mockResolvedValue(null);

    const res = await postApprovedWebhook(app);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { received: true } });
    expect(mockPrisma.pago.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.pago.create).not.toHaveBeenCalled();
    expect(mockPrisma.turno.update).not.toHaveBeenCalled();
    expect(mockSendNotification).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      '[pagos] Ignoring approved payment for non-payable turno',
      expect.objectContaining({ turnoId, turnoEstado: 'MISSING', mpPaymentId: paymentId })
    );
  });
});
