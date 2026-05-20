import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { describe, expect, it, beforeEach, afterEach, jest } from '@jest/globals';
import { generateToken } from '../middleware/auth.middleware';

const mockTx = {
  turno: {
    findMany: jest.fn() as any,
    create: jest.fn() as any,
    update: jest.fn() as any,
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
    findMany: jest.fn() as any,
    findUnique: jest.fn() as any,
  },
  usuario: {
    findUnique: jest.fn() as any,
  },
  bookingVerification: {
    create: jest.fn() as any,
    findUnique: jest.fn() as any,
    delete: jest.fn() as any,
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
import { profesionalesRouter } from '../routes/profesionales.routes';
import { addDaysToClinicDate, clinicDateTimeToUtcDate, formatClinicDateKey, getClinicDateTimeParts, getClinicMonthBounds } from '../utils/clinic-time';

const profesionalId = '11111111-1111-4111-8111-111111111111';
const pacienteUsuarioId = '22222222-2222-4222-8222-222222222222';
const pacienteId = '33333333-3333-4333-8333-333333333333';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/turnos', turnosRouter);
  app.use('/profesionales', profesionalesRouter);
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
  const dateKey = addDaysToClinicDate(formatClinicDateKey(new Date()), 7);
  return clinicDateTimeToUtcDate(dateKey, `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`);
}

function bookingPayload(date = futureSlot(), modalidad: 'PRESENCIAL' | 'VIRTUAL' = 'PRESENCIAL') {
  return {
    profesionalId,
    fechaHora: date.toISOString(),
    modalidad,
  };
}

function setHappyPathMocks(date = futureSlot(), plan: 'PRO' | 'FREE' = 'PRO') {
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
    .mockResolvedValueOnce({ plan });
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
      diaSemana: getClinicDateTimeParts(date).weekday,
      activo: true,
    },
  ]);
  mockPrisma.bloqueoDisponibilidad.findMany.mockResolvedValue([]);
  mockPrisma.turno.count.mockResolvedValue(0);
  mockTx.turno.findMany.mockResolvedValue([]);
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
    mockPrisma.turno.findMany.mockReset();
    mockPrisma.turno.findUnique.mockReset();
    mockPrisma.usuario.findUnique.mockReset();
    mockPrisma.bookingVerification.create.mockReset();
    mockPrisma.bookingVerification.findUnique.mockReset();
    mockPrisma.bookingVerification.delete.mockReset();
    mockTx.turno.findMany.mockReset();
    mockTx.turno.create.mockReset();
    mockTx.turno.update.mockReset();
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

  it('rejects booking the same active interval', async () => {
    const date = futureSlot(10, 0);
    setHappyPathMocks(date);
    mockTx.turno.findMany.mockResolvedValue([
      { fechaHora: date, duracionMin: 30, estado: 'RESERVADO' },
    ]);

    const res = await request(app)
      .post('/turnos/reservar')
      .set('Authorization', `Bearer ${tokenFor('PACIENTE')}`)
      .send(bookingPayload(date))
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('HORARIO_NO_DISPONIBLE');
    expect(mockTx.turno.create).not.toHaveBeenCalled();
  });

  it('allows adjacent 30-minute slots after an existing appointment', async () => {
    const date = futureSlot(10, 30);
    setHappyPathMocks(date);
    mockTx.turno.findMany.mockResolvedValue([
      { fechaHora: futureSlot(10, 0), duracionMin: 30, estado: 'RESERVADO' },
    ]);

    const res = await request(app)
      .post('/turnos/reservar')
      .set('Authorization', `Bearer ${tokenFor('PACIENTE')}`)
      .send(bookingPayload(date))
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(201);
    expect(mockTx.turno.create).toHaveBeenCalled();
  });

  it('allows adjacent 30-minute slots before an existing appointment', async () => {
    const date = futureSlot(10, 0);
    setHappyPathMocks(date);
    mockTx.turno.findMany.mockResolvedValue([
      { fechaHora: futureSlot(10, 30), duracionMin: 30, estado: 'RESERVADO' },
    ]);

    const res = await request(app)
      .post('/turnos/reservar')
      .set('Authorization', `Bearer ${tokenFor('PACIENTE')}`)
      .send(bookingPayload(date))
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(201);
    expect(mockTx.turno.create).toHaveBeenCalled();
  });

  it('rejects booking inside a longer existing appointment', async () => {
    const date = futureSlot(10, 30);
    setHappyPathMocks(date);
    mockTx.turno.findMany.mockResolvedValue([
      { fechaHora: futureSlot(10, 0), duracionMin: 60, estado: 'RESERVADO' },
    ]);

    const res = await request(app)
      .post('/turnos/reservar')
      .set('Authorization', `Bearer ${tokenFor('PACIENTE')}`)
      .send(bookingPayload(date))
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('HORARIO_NO_DISPONIBLE');
    expect(mockTx.turno.create).not.toHaveBeenCalled();
  });

  it('allows booking over a cancelled overlapping appointment', async () => {
    const date = futureSlot(10, 30);
    setHappyPathMocks(date);
    mockTx.turno.findMany.mockResolvedValue([
      { fechaHora: futureSlot(10, 0), duracionMin: 60, estado: 'CANCELADO' },
    ]);

    const res = await request(app)
      .post('/turnos/reservar')
      .set('Authorization', `Bearer ${tokenFor('PACIENTE')}`)
      .send(bookingPayload(date))
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(201);
    expect(mockTx.turno.create).toHaveBeenCalled();
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

  it('rejects bookings that partially overlap a block', async () => {
    const date = futureSlot(10, 0);
    setHappyPathMocks(date);
    mockPrisma.bloqueoDisponibilidad.findMany.mockResolvedValue([
      { horaInicio: '10:15', horaFin: '10:45' },
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

  it('allows bookings adjacent to a partial block', async () => {
    const date = futureSlot(10, 0);
    setHappyPathMocks(date);
    mockPrisma.bloqueoDisponibilidad.findMany.mockResolvedValue([
      { horaInicio: '10:30', horaFin: '11:00' },
    ]);

    const res = await request(app)
      .post('/turnos/reservar')
      .set('Authorization', `Bearer ${tokenFor('PACIENTE')}`)
      .send(bookingPayload(date))
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(201);
    expect(mockTx.turno.create).toHaveBeenCalled();
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

  it('validates late-night slots using Argentina weekday and clock time', async () => {
    const date = futureSlot(23, 30);
    setHappyPathMocks(date);
    mockPrisma.disponibilidad.findMany.mockResolvedValue([
      {
        horaInicio: '23:00',
        horaFin: '23:59',
        modalidad: 'AMBOS',
        lugarAtencion: 'Consultorio nocturno',
        diaSemana: getClinicDateTimeParts(date).weekday,
        activo: true,
      },
    ]);

    const res = await request(app)
      .post('/turnos/reservar')
      .set('Authorization', `Bearer ${tokenFor('PACIENTE')}`)
      .send(bookingPayload(date))
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(201);
    expect(mockTx.turno.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        fechaHora: date,
        lugarAtencion: 'Consultorio nocturno',
      }),
    }));
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

  it('counts FREE plan bookings only inside the requested appointment scheduling month', async () => {
    const date = clinicDateTimeToUtcDate('2030-06-15', '10:00');
    const { start, end } = getClinicMonthBounds(2030, 6);
    setHappyPathMocks(date, 'FREE');
    mockPrisma.turno.count.mockResolvedValue(19);

    const res = await request(app)
      .post('/turnos/reservar')
      .set('Authorization', `Bearer ${tokenFor('PACIENTE')}`)
      .send(bookingPayload(date))
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(201);
    expect(mockPrisma.turno.count).toHaveBeenCalledWith({
      where: {
        profesionalId,
        fechaHora: { gte: start, lt: end },
        estado: { notIn: ['CANCELADO'] },
      },
    });
    expect(mockTx.turno.create).toHaveBeenCalled();
  });

  it('rejects FREE plan bookings when the requested appointment month already has 20 active appointments', async () => {
    const date = clinicDateTimeToUtcDate('2030-06-15', '10:00');
    setHappyPathMocks(date, 'FREE');
    mockPrisma.turno.count.mockResolvedValue(20);

    const res = await request(app)
      .post('/turnos/reservar')
      .set('Authorization', `Bearer ${tokenFor('PACIENTE')}`)
      .send(bookingPayload(date))
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('PLAN_LIMIT_REACHED');
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockTx.turno.create).not.toHaveBeenCalled();
  });

  it('uses Argentina scheduling month for FREE plan limits near UTC month boundaries', async () => {
    const date = new Date('2030-06-01T02:30:00.000Z'); // May 31 23:30 in Argentina
    const { start, end } = getClinicMonthBounds(2030, 5);
    setHappyPathMocks(date, 'FREE');
    mockPrisma.disponibilidad.findMany.mockResolvedValue([
      {
        horaInicio: '23:00',
        horaFin: '23:59',
        modalidad: 'AMBOS',
        lugarAtencion: 'Consultorio nocturno',
        diaSemana: getClinicDateTimeParts(date).weekday,
        activo: true,
      },
    ]);
    mockPrisma.turno.count.mockResolvedValue(19);

    const res = await request(app)
      .post('/turnos/reservar')
      .set('Authorization', `Bearer ${tokenFor('PACIENTE')}`)
      .send(bookingPayload(date))
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(201);
    expect(mockPrisma.turno.count).toHaveBeenCalledWith({
      where: {
        profesionalId,
        fechaHora: { gte: start, lt: end },
        estado: { notIn: ['CANCELADO'] },
      },
    });
  });

  it('marks slots unavailable when they overlap longer appointments', async () => {
    mockPrisma.disponibilidad.findMany.mockResolvedValue([
      {
        horaInicio: '09:00',
        horaFin: '11:00',
        modalidad: 'PRESENCIAL',
        lugarAtencion: null,
        diaSemana: 1,
        activo: true,
      },
    ]);
    mockPrisma.turno.findMany.mockResolvedValue([
      { fechaHora: clinicDateTimeToUtcDate('2026-05-18', '09:30'), duracionMin: 60, estado: 'RESERVADO' },
    ]);
    mockPrisma.bloqueoDisponibilidad.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get(`/turnos/profesional/${profesionalId}/slots-disponibles?fecha=2026-05-18&modalidad=PRESENCIAL`)
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { hora: '09:00', disponible: true },
      { hora: '09:30', disponible: false },
      { hora: '10:00', disponible: false },
      { hora: '10:30', disponible: true },
    ]);
  });

  it('marks legacy turnos slots unavailable when they partially overlap blocks', async () => {
    mockPrisma.disponibilidad.findMany.mockResolvedValue([
      {
        horaInicio: '09:30',
        horaFin: '11:00',
        modalidad: 'PRESENCIAL',
        lugarAtencion: null,
        diaSemana: 1,
        activo: true,
      },
    ]);
    mockPrisma.turno.findMany.mockResolvedValue([]);
    mockPrisma.bloqueoDisponibilidad.findMany.mockResolvedValue([
      { horaInicio: '10:15', horaFin: '10:45' },
    ]);

    const res = await request(app)
      .get(`/turnos/profesional/${profesionalId}/slots-disponibles?fecha=2026-05-18&modalidad=PRESENCIAL`)
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { hora: '09:30', disponible: true },
      { hora: '10:00', disponible: false },
      { hora: '10:30', disponible: false },
    ]);
  });

  it('marks professional slots unavailable when they partially overlap blocks', async () => {
    mockPrisma.disponibilidad.findMany.mockResolvedValue([
      {
        horaInicio: '09:30',
        horaFin: '11:00',
        modalidad: 'PRESENCIAL',
        lugarAtencion: 'Consultorio',
        diaSemana: 1,
        activo: true,
      },
    ]);
    mockPrisma.turno.findMany.mockResolvedValue([]);
    mockPrisma.bloqueoDisponibilidad.findMany.mockResolvedValue([
      { horaInicio: '10:15', horaFin: '10:45' },
    ]);

    const res = await request(app)
      .get(`/profesionales/${profesionalId}/slots-disponibles?fecha=2026-05-18&modalidad=PRESENCIAL`)
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { hora: '09:30', disponible: true, lugarAtencion: 'Consultorio' },
      { hora: '10:00', disponible: false, lugarAtencion: 'Consultorio' },
      { hora: '10:30', disponible: false, lugarAtencion: 'Consultorio' },
    ]);
  });

  it('rejects reprogramming into a partial block overlap', async () => {
    const currentDate = futureSlot(9, 0);
    const newDate = futureSlot(10, 0);
    mockPrisma.turno.findUnique.mockResolvedValue({
      id: 'turno-1',
      profesionalId,
      fechaHora: currentDate,
      duracionMin: 30,
      estado: 'RESERVADO',
      modalidad: 'PRESENCIAL',
      paciente: { usuarioId: pacienteUsuarioId },
      profesional: { usuarioId: '44444444-4444-4444-8444-444444444444' },
      pago: null,
    });
    mockPrisma.disponibilidad.findMany.mockResolvedValue([
      {
        horaInicio: '09:00',
        horaFin: '12:00',
        modalidad: 'AMBOS',
        lugarAtencion: 'Consultorio disponibilidad',
        diaSemana: getClinicDateTimeParts(newDate).weekday,
        activo: true,
      },
    ]);
    mockPrisma.profesional.findUnique.mockResolvedValue({ lugarAtencion: 'Consultorio central' });
    mockPrisma.bloqueoDisponibilidad.findMany.mockResolvedValue([
      { horaInicio: '10:15', horaFin: '10:45' },
    ]);

    const res = await request(app)
      .post('/turnos/turno-1/reprogramar')
      .set('Authorization', `Bearer ${tokenFor('PACIENTE')}`)
      .send({ fechaHora: newDate.toISOString(), modalidad: 'PRESENCIAL' })
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('HORARIO_BLOQUEADO');
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  describe('Guest Booking (Gated behind feature flag)', () => {
    let originalEnv: string | undefined;

    beforeEach(() => {
      originalEnv = process.env.ENABLE_GUEST_BOOKING;
    });

    afterEach(() => {
      process.env.ENABLE_GUEST_BOOKING = originalEnv;
    });

    it('rejects guest booking with 401 when ENABLE_GUEST_BOOKING is not true', async () => {
      process.env.ENABLE_GUEST_BOOKING = 'false';

      const res = await request(app)
        .post('/turnos/reservar')
        .send(bookingPayload())
        .timeout({ deadline: 500 });

      expect(res.status).toBe(401);
      expect(res.body.error?.code).toBe('UNAUTHORIZED');
      expect(mockPrisma.bookingVerification.create).not.toHaveBeenCalled();
    });

    it('creates a pending booking verification when ENABLE_GUEST_BOOKING is true', async () => {
      process.env.ENABLE_GUEST_BOOKING = 'true';

      const date = futureSlot();
      setHappyPathMocks(date);
      mockPrisma.bookingVerification.create.mockResolvedValue({ id: 'verification-1' });
      mockPrisma.turno.findMany.mockResolvedValue([]);

      const res = await request(app)
        .post('/turnos/reservar')
        .send({
          ...bookingPayload(date),
          email: 'guest@test.com',
          pacienteData: {
            nombre: 'Juan',
            apellido: 'Perez',
            telefono: '123456789'
          }
        })
        .timeout({ deadline: 1000 });

      expect(res.status).toBe(202);
      expect(res.body.data.message).toContain('Verifica tu email');
      expect(mockPrisma.bookingVerification.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          email: 'guest@test.com',
          nombre: 'Juan',
          apellido: 'Perez',
        })
      }));
    });
  });
});
