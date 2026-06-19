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

// Keep the router's dependency graph cheap + deterministic.
jest.mock('../utils/notifications', () => ({
  sendNotification: jest.fn(async () => undefined),
  resolveChannels: jest.fn(() => []),
}));
jest.mock('../services/notification.service', () => ({
  createNotification: jest.fn(async () => undefined),
}));
jest.mock('../services/waitlist.service', () => ({
  notifyWaitlistForReleasedSlot: jest.fn(async () => undefined),
  resolveWaitlistForBooking: jest.fn(async () => undefined),
}));
jest.mock('../services/calendar-sync.service', () => ({
  syncTurnoCreated: jest.fn(() => Promise.resolve()),
  syncTurnoRescheduled: jest.fn(() => Promise.resolve()),
  syncTurnoCancelled: jest.fn(() => Promise.resolve()),
  syncTurnoCreatedForPaciente: jest.fn(() => Promise.resolve()),
  syncTurnoRescheduledForPaciente: jest.fn(() => Promise.resolve()),
  syncTurnoCancelledForPaciente: jest.fn(() => Promise.resolve()),
}));
jest.mock('../services/preconsulta.service', () => ({
  analyzePreconsulta: jest.fn(async () => null),
}));
jest.mock('../services/video-room.service', () => ({
  issueVideoTicket: jest.fn(() => 'ticket-x'),
}));

const STUN_STUB = [{ urls: 'stun:stun.l.google.com:19302' }];
jest.mock('../services/turn.service', () => ({
  getIceServers: jest.fn(async () => STUN_STUB),
}));

import { turnosRouter } from '../routes/turnos.routes';

const pacienteUsuarioId = '11111111-1111-4111-8111-111111111111';
const profesionalUsuarioId = '22222222-2222-4222-8222-222222222222';
const strangerUsuarioId = '33333333-3333-4333-8333-333333333333';
const turnoId = 'turno-1';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/turnos', turnosRouter);
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err.statusCode || 500).json({
      success: false,
      error: { code: err.code || 'INTERNAL_ERROR', message: err.message },
    });
  });
  return app;
}

function tokenFor(userId: string, rol: 'PACIENTE' | 'PROFESIONAL' = 'PACIENTE') {
  return generateToken({ userId, email: `${userId}@test.com`, rol });
}

/** A turno as returned by assertTurnoAccess (findUnique with paciente/profesional/pago). */
function mockTurno(overrides: Partial<{
  modalidad: 'PRESENCIAL' | 'VIRTUAL';
  estado: string;
  fechaHora: Date;
  duracionMin: number;
}> = {}) {
  mockPrisma.turno.findUnique.mockResolvedValue({
    id: turnoId,
    modalidad: overrides.modalidad ?? 'VIRTUAL',
    estado: overrides.estado ?? 'CONFIRMADO',
    fechaHora: overrides.fechaHora ?? new Date(),
    duracionMin: overrides.duracionMin ?? 30,
    paciente: { usuarioId: pacienteUsuarioId },
    profesional: { usuarioId: profesionalUsuarioId },
    pago: null,
  });
}

async function getVideoToken(app: ReturnType<typeof makeApp>, userId: string) {
  return request(app)
    .get(`/turnos/${turnoId}/video-token`)
    .set('Authorization', `Bearer ${tokenFor(userId)}`)
    .timeout({ deadline: 1000 });
}

describe('GET /turnos/:id/video-token', () => {
  const app = makeApp();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects non-virtual turnos', async () => {
    mockTurno({ modalidad: 'PRESENCIAL' });

    const res = await getVideoToken(app, pacienteUsuarioId);

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('NOT_VIRTUAL');
  });

  it('rejects invalid states (e.g. cancelled)', async () => {
    mockTurno({ modalidad: 'VIRTUAL', estado: 'CANCELADO' });

    const res = await getVideoToken(app, pacienteUsuarioId);

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('INVALID_STATE');
  });

  it('rejects users who are neither the patient nor the assigned professional', async () => {
    mockTurno({ modalidad: 'VIRTUAL', estado: 'CONFIRMADO' });

    const res = await getVideoToken(app, strangerUsuarioId);

    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('FORBIDDEN');
  });

  it('rejects requests outside the 15-minute join window', async () => {
    mockTurno({
      modalidad: 'VIRTUAL',
      estado: 'CONFIRMADO',
      fechaHora: new Date(Date.now() + 2 * 60 * 60 * 1000), // 2h ahead
    });

    const res = await getVideoToken(app, pacienteUsuarioId);

    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('OUTSIDE_JOIN_WINDOW');
  });

  it('returns a ticket and WebRTC ICE servers inside the join window', async () => {
    mockTurno({ modalidad: 'VIRTUAL', estado: 'CONFIRMADO', fechaHora: new Date() });

    const res = await getVideoToken(app, pacienteUsuarioId);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      ticket: 'ticket-x',
      roomId: turnoId,
      iceServers: STUN_STUB,
    });
  });

  it('allows the assigned professional to join inside the window', async () => {
    mockTurno({ modalidad: 'VIRTUAL', estado: 'CONFIRMADO', fechaHora: new Date() });

    const res = await request(app)
      .get(`/turnos/${turnoId}/video-token`)
      .set('Authorization', `Bearer ${tokenFor(profesionalUsuarioId, 'PROFESIONAL')}`)
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(200);
    expect(res.body.data.ticket).toBe('ticket-x');
  });
});
