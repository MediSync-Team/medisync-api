import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { describe, expect, it, beforeEach, jest } from '@jest/globals';
import { generateToken } from '../middleware/auth.middleware';

const mockTx = {
  turno: {
    findFirst: jest.fn() as any,
    create: jest.fn() as any,
  },
};

const mockPrisma = {
  profesional: {
    findUnique: jest.fn() as any,
  },
  paciente: {
    findUnique: jest.fn() as any,
  },
  disponibilidad: {
    findMany: jest.fn() as any,
  },
  bloqueoDisponibilidad: {
    findMany: jest.fn() as any,
  },
  turno: {
    count: jest.fn() as any,
    findUnique: jest.fn() as any,
  },
  usuario: {
    findUnique: jest.fn() as any,
  },
  $transaction: jest.fn() as any,
};

jest.mock('../lib/prisma', () => ({
  __esModule: true,
  default: mockPrisma,
}));

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
  issueVideoTicket: jest.fn(async () => ({ token: 'video-token' })),
}));

jest.mock('../utils/auth-helpers', () => ({
  getProfesionalIdByUsuario: jest.fn(async () => 'prof-1'),
}));

import { turnosRouter } from '../routes/turnos.routes';

const profesionalId = '11111111-1111-4111-8111-111111111111';
const pacienteUsuarioId = '22222222-2222-4222-8222-222222222222';
const pacienteId = '33333333-3333-4333-8333-333333333333';

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

function tokenFor(rol: 'PACIENTE' | 'PROFESIONAL' | 'ADMIN' | 'CLINICA') {
  return generateToken({
    userId: rol === 'PACIENTE' ? pacienteUsuarioId : '99999999-9999-4999-8999-999999999999',
    email: `${rol.toLowerCase()}@test.com`,
    rol,
  });
}

function futureSlot(hours = 10, minutes = 0) {
  const date = new Date();
  date.setDate(date.getDate() + 7);
  date.setHours(hours, minutes, 0, 0);
  return date;
}

function bookingPayload(date = futureSlot(), modalidad: 'PRESENCIAL' | 'VIRTUAL' = 'PRESENCIAL') {
  return {
    profesionalId,
    fechaHora: date.toISOString(),
    modalidad,
  };
}

function setHappyPathMocks(date = futureSlot()) {
  mockPrisma.profesional.findUnique
    .mockResolvedValueOnce({
      id: profesionalId,
      activo: true,
      lugarAtencion: 'Consultorio central',
      usuarioId: '44444444-4444-4444-8444-444444444444',
      nombre: 'Pedro',
      apellido: 'Franchetti',
      notifEmail: true,
      notifWhatsapp: false,
      telefono: null,
    })
    .mockResolvedValueOnce({ plan: 'PRO' });
  mockPrisma.paciente.findUnique.mockResolvedValue({
    id: pacienteId,
    usuarioId: pacienteUsuarioId,
    nombre: 'Franco',
    apellido: 'Pedretti',
    email: 'franco@test.com',
    telefono: null,
    notifEmail: true,
    notifWhatsapp: false,
  });
  mockPrisma.disponibilidad.findMany.mockResolvedValue([
    {
      horaInicio: '09:00',
      horaFin: '12:00',
      modalidad: 'AMBOS',
      lugarAtencion: 'Consultorio disponibilidad',
      diaSemana: date.getDay(),
      activo: true,
    },
  ]);
  mockPrisma.bloqueoDisponibilidad.findMany.mockResolvedValue([]);
  mockPrisma.turno.count.mockResolvedValue(0);
  mockTx.turno.findFirst.mockResolvedValue(null);
  mockTx.turno.create.mockResolvedValue({
    id: 'turno-1',
    profesionalId,
    pacienteId,
    fechaHora: date,
    modalidad: 'PRESENCIAL',
    duracionMin: 30,
    estado: 'RESERVADO',
  });
  mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockTx));
  mockPrisma.turno.findUnique.mockResolvedValue({
    id: 'turno-1',
    profesionalId,
    pacienteId,
    fechaHora: date,
    modalidad: 'PRESENCIAL',
    duracionMin: 30,
    estado: 'RESERVADO',
    lugarAtencion: 'Consultorio disponibilidad',
    paciente: {
      id: pacienteId,
      usuarioId: pacienteUsuarioId,
      nombre: 'Franco',
      apellido: 'Pedretti',
      email: 'franco@test.com',
      telefono: null,
      notifEmail: true,
      notifWhatsapp: false,
    },
    profesional: {
      id: profesionalId,
      usuarioId: '44444444-4444-4444-8444-444444444444',
      nombre: 'Pedro',
      apellido: 'Franchetti',
      lugarAtencion: 'Consultorio central',
      notifEmail: true,
      notifWhatsapp: false,
      telefono: null,
    },
  });
  mockPrisma.usuario.findUnique.mockResolvedValue({ id: '44444444-4444-4444-8444-444444444444', email: 'doc@test.com' });
}

describe('POST /turnos/reservar', () => {
  const app = makeApp();

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.$transaction.mockReset();
    mockPrisma.profesional.findUnique.mockReset();
    mockPrisma.paciente.findUnique.mockReset();
    mockPrisma.disponibilidad.findMany.mockReset();
    mockPrisma.bloqueoDisponibilidad.findMany.mockReset();
    mockPrisma.turno.count.mockReset();
    mockPrisma.turno.findUnique.mockReset();
    mockPrisma.usuario.findUnique.mockReset();
    mockTx.turno.findFirst.mockReset();
    mockTx.turno.create.mockReset();
  });

  it.each(['PROFESIONAL', 'ADMIN', 'CLINICA'] as const)('rejects %s tokens before booking logic', async (rol) => {
    const res = await request(app)
      .post('/turnos/reservar')
      .set('Authorization', `Bearer ${tokenFor(rol)}`)
      .send(bookingPayload())
      .timeout({ deadline: 500 });

    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('FORBIDDEN');
    expect(mockPrisma.profesional.findUnique).not.toHaveBeenCalled();
  });

  it('returns PACIENTE_NOT_FOUND when the authenticated user has no patient profile', async () => {
    mockPrisma.profesional.findUnique.mockResolvedValue({ id: profesionalId, activo: true });
    mockPrisma.paciente.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/turnos/reservar')
      .set('Authorization', `Bearer ${tokenFor('PACIENTE')}`)
      .send(bookingPayload())
      .timeout({ deadline: 500 });

    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('PACIENTE_NOT_FOUND');
  });

  it('uses the authenticated patient identity and ignores body patient data', async () => {
    const date = futureSlot();
    setHappyPathMocks(date);

    const res = await request(app)
      .post('/turnos/reservar')
      .set('Authorization', `Bearer ${tokenFor('PACIENTE')}`)
      .send({
        ...bookingPayload(date),
        paciente: { email: 'other@test.com', nombre: 'Other', apellido: 'Patient' },
      })
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ linkPago: null });
    expect(mockPrisma.paciente.findUnique).toHaveBeenCalledWith({ where: { usuarioId: pacienteUsuarioId } });
    expect(mockTx.turno.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ pacienteId }),
    }));
  });

  it('rejects bookings outside active availability', async () => {
    mockPrisma.profesional.findUnique.mockResolvedValue({ id: profesionalId, activo: true });
    mockPrisma.paciente.findUnique.mockResolvedValue({ id: pacienteId, usuarioId: pacienteUsuarioId });
    mockPrisma.disponibilidad.findMany.mockResolvedValue([]);

    const res = await request(app)
      .post('/turnos/reservar')
      .set('Authorization', `Bearer ${tokenFor('PACIENTE')}`)
      .send(bookingPayload())
      .timeout({ deadline: 500 });

    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('HORARIO_NO_DISPONIBLE');
  });

  it('rejects bookings with the wrong modality for the availability', async () => {
    const date = futureSlot();
    mockPrisma.profesional.findUnique.mockResolvedValue({ id: profesionalId, activo: true });
    mockPrisma.paciente.findUnique.mockResolvedValue({ id: pacienteId, usuarioId: pacienteUsuarioId });
    mockPrisma.disponibilidad.findMany.mockResolvedValue([
      { horaInicio: '09:00', horaFin: '12:00', modalidad: 'VIRTUAL', lugarAtencion: null },
    ]);

    const res = await request(app)
      .post('/turnos/reservar')
      .set('Authorization', `Bearer ${tokenFor('PACIENTE')}`)
      .send(bookingPayload(date, 'PRESENCIAL'))
      .timeout({ deadline: 500 });

    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('HORARIO_NO_DISPONIBLE');
  });

  it('rejects bookings inside a full-day block', async () => {
    const date = futureSlot();
    setHappyPathMocks(date);
    mockPrisma.bloqueoDisponibilidad.findMany.mockResolvedValue([
      { horaInicio: null, horaFin: null },
    ]);

    const res = await request(app)
      .post('/turnos/reservar')
      .set('Authorization', `Bearer ${tokenFor('PACIENTE')}`)
      .send(bookingPayload(date))
      .timeout({ deadline: 500 });

    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('HORARIO_BLOQUEADO');
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects bookings inside a partial block', async () => {
    const date = futureSlot(10, 30);
    setHappyPathMocks(date);
    mockPrisma.bloqueoDisponibilidad.findMany.mockResolvedValue([
      { horaInicio: '10:00', horaFin: '11:00' },
    ]);

    const res = await request(app)
      .post('/turnos/reservar')
      .set('Authorization', `Bearer ${tokenFor('PACIENTE')}`)
      .send(bookingPayload(date))
      .timeout({ deadline: 500 });

    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('HORARIO_BLOQUEADO');
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects non half-hour slot times', async () => {
    const res = await request(app)
      .post('/turnos/reservar')
      .set('Authorization', `Bearer ${tokenFor('PACIENTE')}`)
      .send(bookingPayload(futureSlot(10, 15)))
      .timeout({ deadline: 500 });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
  });

  it('creates a valid authenticated patient booking with linkPago null', async () => {
    const date = futureSlot(10, 0);
    setHappyPathMocks(date);

    const res = await request(app)
      .post('/turnos/reservar')
      .set('Authorization', `Bearer ${tokenFor('PACIENTE')}`)
      .send(bookingPayload(date))
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      linkPago: null,
      turno: { id: 'turno-1', pacienteId },
    });
    expect(mockTx.turno.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        pacienteId,
        lugarAtencion: 'Consultorio disponibilidad',
      }),
    }));
  });
});
