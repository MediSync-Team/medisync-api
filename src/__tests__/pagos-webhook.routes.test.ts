import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { describe, expect, it, beforeEach, afterEach, jest } from '@jest/globals';

const mockPrisma = {
  turno: {
    findUnique: jest.fn() as any,
    update: jest.fn() as any,
  },
  pago: {
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
    mockPrisma.pago.upsert.mockResolvedValue({ id: 'pago-1', cuponId: null });
    mockUpdatedTurno();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('approves payment and confirms a RESERVADO turno', async () => {
    mockPrisma.turno.findUnique.mockResolvedValue({ estado: 'RESERVADO' });

    const res = await postApprovedWebhook(app);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { received: true } });
    expect(mockPrisma.pago.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { turnoId },
      update: expect.objectContaining({ estado: 'APROBADO', mpPaymentId: paymentId }),
      create: expect.objectContaining({ turnoId, estado: 'APROBADO', mpPaymentId: paymentId }),
    }));
    expect(mockPrisma.turno.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: turnoId },
      data: { estado: 'CONFIRMADO' },
    }));
    expect(mockSendNotification).toHaveBeenCalled();
  });

  it('approves payment for an already CONFIRMADO turno and keeps it confirmed', async () => {
    mockPrisma.turno.findUnique.mockResolvedValue({ estado: 'CONFIRMADO' });
    mockUpdatedTurno('CONFIRMADO');

    const res = await postApprovedWebhook(app);

    expect(res.status).toBe(200);
    expect(mockPrisma.pago.upsert).toHaveBeenCalled();
    expect(mockPrisma.turno.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { estado: 'CONFIRMADO' },
    }));
  });

  it.each(['CANCELADO', 'COMPLETADO', 'AUSENTE'] as const)(
    'ignores approved payments for %s turnos without approving revenue',
    async (estado) => {
      mockPrisma.turno.findUnique.mockResolvedValue({ estado });

      const res = await postApprovedWebhook(app);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, data: { received: true } });
      expect(mockPrisma.pago.upsert).not.toHaveBeenCalled();
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
    expect(mockPrisma.pago.upsert).not.toHaveBeenCalled();
    expect(mockPrisma.turno.update).not.toHaveBeenCalled();
    expect(mockSendNotification).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      '[pagos] Ignoring approved payment for non-payable turno',
      expect.objectContaining({ turnoId, turnoEstado: 'MISSING', mpPaymentId: paymentId })
    );
  });
});
