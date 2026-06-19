import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { describe, expect, it, beforeEach, afterEach, jest } from '@jest/globals';
import { generateToken } from '../middleware/auth.middleware';

const mockTx = {
  $executeRaw: jest.fn() as any,
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
    findFirst: jest.fn() as any,
    create: jest.fn() as any,
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
    update: jest.fn() as any,
    updateMany: jest.fn() as any,
  },
  auditoriaDisponibilidad: {
    create: jest.fn() as any,
  },
  usuario: {
    findUnique: jest.fn() as any,
  },
  bookingVerification: {
    create: jest.fn() as any,
    findUnique: jest.fn() as any,
    delete: jest.fn() as any,
  },
  recetaIndicacion: {
    upsert: jest.fn() as any,
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
import { sendNotification } from '../utils/notifications';
import { createNotification } from '../services/notification.service';
import { notifyWaitlistForReleasedSlot } from '../services/waitlist.service';
import { syncTurnoCancelled, syncTurnoCancelledForPaciente } from '../services/calendar-sync.service';

const profesionalId = '11111111-1111-4111-8111-111111111111';
const pacienteUsuarioId = '22222222-2222-4222-8222-222222222222';
const pacienteId = '33333333-3333-4333-8333-333333333333';
const profesionalUsuarioId = '99999999-9999-4999-8999-999999999999';

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

function setReprogramHappyPathMocks(options: {
  currentModalidad: 'PRESENCIAL' | 'VIRTUAL';
  currentLinkVideollamada?: string | null;
  disponibilidadLugar?: string | null;
  profesionalLugar?: string | null;
}) {
  const currentDate = futureSlot(9, 0);
  const newDate = futureSlot(10, 0);
  const currentLugar = options.currentModalidad === 'PRESENCIAL' ? 'Consultorio anterior' : null;
  const disponibilidadLugar = options.disponibilidadLugar !== undefined
    ? options.disponibilidadLugar
    : 'Consultorio disponibilidad';
  const profesionalLugar = options.profesionalLugar !== undefined
    ? options.profesionalLugar
    : 'Consultorio central';

  mockPrisma.turno.findUnique.mockResolvedValue({
    id: 'turno-1',
    profesionalId,
    pacienteId,
    fechaHora: currentDate,
    duracionMin: 30,
    estado: 'RESERVADO',
    modalidad: options.currentModalidad,
    lugarAtencion: currentLugar,
    linkVideollamada: options.currentLinkVideollamada ?? null,
    paciente: { usuarioId: pacienteUsuarioId },
    profesional: { usuarioId: profesionalUsuarioId },
    pago: null,
  });
  mockPrisma.disponibilidad.findMany.mockResolvedValue([
    {
      horaInicio: '09:00',
      horaFin: '12:00',
      modalidad: 'AMBOS',
      lugarAtencion: disponibilidadLugar,
      diaSemana: getClinicDateTimeParts(newDate).weekday,
      activo: true,
    },
  ]);
  mockPrisma.profesional.findUnique.mockResolvedValue({ lugarAtencion: profesionalLugar });
  mockPrisma.bloqueoDisponibilidad.findMany.mockResolvedValue([]);
  mockTx.turno.findMany.mockResolvedValue([]);
  mockTx.turno.update.mockImplementation(async ({ data }: any) => ({
    id: 'turno-1',
    profesionalId,
    pacienteId,
    duracionMin: 30,
    ...data,
    paciente: {
      id: pacienteId,
      usuarioId: pacienteUsuarioId,
      nombre: 'Franco',
      apellido: 'Pedretti',
      email: 'franco@test.com',
      telefono: null,
      notifEmail: true,
      notifWhatsapp: false,
      usuario: { id: pacienteUsuarioId },
    },
    profesional: {
      id: profesionalId,
      usuarioId: profesionalUsuarioId,
      nombre: 'Pedro',
      apellido: 'Franchetti',
      lugarAtencion: profesionalLugar,
      notifEmail: true,
      notifWhatsapp: false,
      telefono: null,
    },
    pago: null,
  }));
  mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockTx));

  return { newDate };
}

function makePatchTurno(estado: 'RESERVADO' | 'CONFIRMADO' | 'COMPLETADO' | 'CANCELADO' | 'AUSENTE', fechaHora = futureSlot()) {
  return {
    id: 'turno-1',
    profesionalId,
    pacienteId,
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
      usuarioId: profesionalUsuarioId,
      nombre: 'Pedro',
      apellido: 'Franchetti',
      lugarAtencion: 'Consultorio central',
      notifEmail: true,
      notifWhatsapp: false,
      telefono: null,
      especialidad: { nombre: 'Clinica medica' },
    },
    fechaHora,
    duracionMin: 30,
    estado,
    modalidad: 'PRESENCIAL',
    lugarAtencion: 'Consultorio central',
    linkVideollamada: null,
    pago: null,
  };
}

function expectNoCancellationSideEffects() {
  expect(sendNotification).not.toHaveBeenCalled();
  expect(createNotification).not.toHaveBeenCalled();
  expect(notifyWaitlistForReleasedSlot).not.toHaveBeenCalled();
  expect(mockPrisma.auditoriaDisponibilidad.create).not.toHaveBeenCalled();
  expect(syncTurnoCancelled).not.toHaveBeenCalled();
  expect(syncTurnoCancelledForPaciente).not.toHaveBeenCalled();
}

describe('POST /turnos/reservar', () => {
  const app = makeApp();

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.$transaction.mockReset();
    mockPrisma.profesional.findUnique.mockReset();
    mockPrisma.paciente.findUnique.mockReset();
    mockPrisma.paciente.findFirst.mockReset();
    mockPrisma.paciente.create.mockReset();
    mockPrisma.disponibilidad.findMany.mockReset();
    mockPrisma.bloqueoDisponibilidad.findMany.mockReset();
    mockPrisma.turno.count.mockReset();
    mockPrisma.turno.findMany.mockReset();
    mockPrisma.turno.findUnique.mockReset();
    mockPrisma.turno.update.mockReset();
    mockPrisma.turno.updateMany.mockReset();
    mockPrisma.auditoriaDisponibilidad.create.mockReset();
    mockPrisma.usuario.findUnique.mockReset();
    mockPrisma.bookingVerification.create.mockReset();
    mockPrisma.bookingVerification.findUnique.mockReset();
    mockPrisma.bookingVerification.delete.mockReset();
    mockPrisma.recetaIndicacion.upsert.mockReset();
    mockTx.$executeRaw.mockReset();
    mockTx.turno.findMany.mockReset();
    mockTx.turno.create.mockReset();
    mockTx.turno.update.mockReset();
    mockTx.$executeRaw.mockResolvedValue(undefined);
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

  it('acquires the professional-day advisory lock before booking conflict reads', async () => {
    const date = futureSlot();
    setHappyPathMocks(date);

    const res = await request(app)
      .post('/turnos/reservar')
      .set('Authorization', `Bearer ${tokenFor('PACIENTE')}`)
      .send(bookingPayload(date))
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(201);
    expect(mockTx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(mockTx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mockTx.turno.findMany.mock.invocationCallOrder[0]
    );
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

  it('rejects bookings that do not fully fit inside availability', async () => {
    const date = futureSlot(10, 0);
    mockPrisma.profesional.findUnique.mockResolvedValue({ id: profesionalId, activo: true });
    mockPrisma.paciente.findUnique.mockResolvedValue({ id: pacienteId, usuarioId: pacienteUsuarioId });
    mockPrisma.disponibilidad.findMany.mockResolvedValue([
      { horaInicio: '09:00', horaFin: '10:15', modalidad: 'PRESENCIAL', lugarAtencion: null },
    ]);

    const res = await request(app)
      .post('/turnos/reservar')
      .set('Authorization', `Bearer ${tokenFor('PACIENTE')}`)
      .send(bookingPayload(date, 'PRESENCIAL'))
      .timeout({ deadline: 500 });

    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('HORARIO_NO_DISPONIBLE');
    expect(mockPrisma.bloqueoDisponibilidad.findMany).not.toHaveBeenCalled();
  });

  it('allows bookings ending exactly at availability end', async () => {
    const date = futureSlot(10, 0);
    setHappyPathMocks(date);
    mockPrisma.disponibilidad.findMany.mockResolvedValue([
      {
        horaInicio: '09:00',
        horaFin: '10:30',
        modalidad: 'PRESENCIAL',
        lugarAtencion: 'Consultorio disponibilidad',
        diaSemana: getClinicDateTimeParts(date).weekday,
        activo: true,
      },
    ]);

    const res = await request(app)
      .post('/turnos/reservar')
      .set('Authorization', `Bearer ${tokenFor('PACIENTE')}`)
      .send(bookingPayload(date, 'PRESENCIAL'))
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(201);
    expect(mockTx.turno.create).toHaveBeenCalled();
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
        horaFin: '24:00',
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
        horaFin: '24:00',
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
      { hora: '09:00', disponible: true, lugarAtencion: null },
      { hora: '09:30', disponible: false, lugarAtencion: null },
      { hora: '10:00', disponible: false, lugarAtencion: null },
      { hora: '10:30', disponible: true, lugarAtencion: null },
    ]);
  });

  it('marks legacy turnos slots unavailable when they partially overlap blocks', async () => {
    mockPrisma.disponibilidad.findMany.mockResolvedValue([
      {
        horaInicio: '09:30',
        horaFin: '11:00',
        modalidad: 'PRESENCIAL',
        lugarAtencion: 'Consultorio legacy',
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
      { hora: '09:30', disponible: true, lugarAtencion: 'Consultorio legacy' },
      { hora: '10:00', disponible: false, lugarAtencion: 'Consultorio legacy' },
      { hora: '10:30', disponible: false, lugarAtencion: 'Consultorio legacy' },
    ]);
  });

  it('returns identical slot data from legacy turnos and professional endpoints', async () => {
    const disponibilidad = [
      {
        horaInicio: '09:30',
        horaFin: '11:00',
        modalidad: 'AMBOS',
        lugarAtencion: 'Consultorio compartido',
        diaSemana: 1,
        activo: true,
      },
    ];
    const turnosOcupados = [
      { fechaHora: clinicDateTimeToUtcDate('2026-05-18', '10:30'), duracionMin: 30, estado: 'RESERVADO' },
    ];
    const bloqueos = [
      { horaInicio: '09:45', horaFin: '10:15' },
    ];

    mockPrisma.disponibilidad.findMany.mockResolvedValue(disponibilidad);
    mockPrisma.turno.findMany.mockResolvedValue(turnosOcupados);
    mockPrisma.bloqueoDisponibilidad.findMany.mockResolvedValue(bloqueos);

    const legacyRes = await request(app)
      .get(`/turnos/profesional/${profesionalId}/slots-disponibles?fecha=2026-05-18&modalidad=VIRTUAL`)
      .timeout({ deadline: 1000 });

    mockPrisma.disponibilidad.findMany.mockResolvedValue(disponibilidad);
    mockPrisma.turno.findMany.mockResolvedValue(turnosOcupados);
    mockPrisma.bloqueoDisponibilidad.findMany.mockResolvedValue(bloqueos);

    const professionalRes = await request(app)
      .get(`/profesionales/${profesionalId}/slots-disponibles?fecha=2026-05-18&modalidad=VIRTUAL`)
      .timeout({ deadline: 1000 });

    expect(legacyRes.status).toBe(200);
    expect(professionalRes.status).toBe(200);
    expect(legacyRes.body.data).toEqual(professionalRes.body.data);
    expect(legacyRes.body.data).toEqual([
      { hora: '09:30', disponible: false, lugarAtencion: 'Consultorio compartido' },
      { hora: '10:00', disponible: false, lugarAtencion: 'Consultorio compartido' },
      { hora: '10:30', disponible: false, lugarAtencion: 'Consultorio compartido' },
    ]);
  });

  it.each([
    ['turnos legacy', `/turnos/profesional/${profesionalId}/slots-disponibles?fecha=2026-05-18&modalidad=PRESENCIAL`],
    ['professional', `/profesionales/${profesionalId}/slots-disponibles?fecha=2026-05-18&modalidad=PRESENCIAL`],
  ])('returns no slots for a full-day block on the %s endpoint', async (_label, path) => {
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
      { horaInicio: null, horaFin: null },
    ]);

    const res = await request(app)
      .get(path)
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
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

  it('does not expose slots that do not fully fit inside availability', async () => {
    mockPrisma.disponibilidad.findMany.mockResolvedValue([
      {
        horaInicio: '09:00',
        horaFin: '10:15',
        modalidad: 'PRESENCIAL',
        lugarAtencion: 'Consultorio corto',
        diaSemana: 1,
        activo: true,
      },
    ]);
    mockPrisma.turno.findMany.mockResolvedValue([]);
    mockPrisma.bloqueoDisponibilidad.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get(`/profesionales/${profesionalId}/slots-disponibles?fecha=2026-05-18&modalidad=PRESENCIAL`)
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { hora: '09:00', disponible: true, lugarAtencion: 'Consultorio corto' },
      { hora: '09:30', disponible: true, lugarAtencion: 'Consultorio corto' },
    ]);
  });

  it('rejects reprogramming a 30-minute appointment that does not fully fit inside availability', async () => {
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
        horaFin: '10:15',
        modalidad: 'AMBOS',
        lugarAtencion: 'Consultorio disponibilidad',
        diaSemana: getClinicDateTimeParts(newDate).weekday,
        activo: true,
      },
    ]);

    const res = await request(app)
      .post('/turnos/turno-1/reprogramar')
      .set('Authorization', `Bearer ${tokenFor('PACIENTE')}`)
      .send({ fechaHora: newDate.toISOString(), modalidad: 'PRESENCIAL' })
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('HORARIO_NO_DISPONIBLE');
    expect(mockPrisma.profesional.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects reprogramming a longer appointment that does not fully fit inside availability', async () => {
    const currentDate = futureSlot(9, 0);
    const newDate = futureSlot(10, 0);
    mockPrisma.turno.findUnique.mockResolvedValue({
      id: 'turno-1',
      profesionalId,
      fechaHora: currentDate,
      duracionMin: 60,
      estado: 'RESERVADO',
      modalidad: 'PRESENCIAL',
      paciente: { usuarioId: pacienteUsuarioId },
      profesional: { usuarioId: '44444444-4444-4444-8444-444444444444' },
      pago: null,
    });
    mockPrisma.disponibilidad.findMany.mockResolvedValue([
      {
        horaInicio: '09:00',
        horaFin: '10:30',
        modalidad: 'AMBOS',
        lugarAtencion: 'Consultorio disponibilidad',
        diaSemana: getClinicDateTimeParts(newDate).weekday,
        activo: true,
      },
    ]);

    const res = await request(app)
      .post('/turnos/turno-1/reprogramar')
      .set('Authorization', `Bearer ${tokenFor('PACIENTE')}`)
      .send({ fechaHora: newDate.toISOString(), modalidad: 'PRESENCIAL' })
      .timeout({ deadline: 1000 });

    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('HORARIO_NO_DISPONIBLE');
    expect(mockPrisma.profesional.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
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

  describe('Cancellation idempotency', () => {
    it('cancels a reserved appointment once and runs cancellation side effects', async () => {
      const activeTurno = makePatchTurno('RESERVADO');
      const cancelledTurno = { ...activeTurno, estado: 'CANCELADO' };
      mockPrisma.turno.findUnique
        .mockResolvedValueOnce(activeTurno)
        .mockResolvedValueOnce(cancelledTurno);
      mockPrisma.turno.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.auditoriaDisponibilidad.create.mockResolvedValue({ id: 'audit-1' });

      const res = await request(app)
        .patch('/turnos/turno-1')
        .set('Authorization', `Bearer ${tokenFor('PROFESIONAL')}`)
        .send({ estado: 'CANCELADO', notasCancelacion: 'No atiendo ese dia' })
        .timeout({ deadline: 1000 });

      expect(res.status).toBe(200);
      expect(mockPrisma.turno.updateMany).toHaveBeenCalledWith({
        where: { id: 'turno-1', estado: { in: ['RESERVADO', 'CONFIRMADO'] } },
        data: { estado: 'CANCELADO', notasCancelacion: 'No atiendo ese dia' },
      });
      expect(sendNotification).toHaveBeenCalledTimes(1);
      expect(createNotification).toHaveBeenCalledTimes(1);
      expect(notifyWaitlistForReleasedSlot).toHaveBeenCalledTimes(1);
      expect(mockPrisma.auditoriaDisponibilidad.create).toHaveBeenCalledTimes(1);
      expect(syncTurnoCancelled).toHaveBeenCalledTimes(1);
      expect(syncTurnoCancelledForPaciente).toHaveBeenCalledTimes(1);
    });

    it('cancels a confirmed appointment once and runs cancellation side effects', async () => {
      const activeTurno = makePatchTurno('CONFIRMADO');
      const cancelledTurno = { ...activeTurno, estado: 'CANCELADO' };
      mockPrisma.turno.findUnique
        .mockResolvedValueOnce(activeTurno)
        .mockResolvedValueOnce(cancelledTurno);
      mockPrisma.turno.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.auditoriaDisponibilidad.create.mockResolvedValue({ id: 'audit-1' });

      const res = await request(app)
        .patch('/turnos/turno-1')
        .set('Authorization', `Bearer ${tokenFor('PROFESIONAL')}`)
        .send({ estado: 'CANCELADO' })
        .timeout({ deadline: 1000 });

      expect(res.status).toBe(200);
      expect(mockPrisma.turno.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'turno-1', estado: { in: ['RESERVADO', 'CONFIRMADO'] } },
      }));
      expect(notifyWaitlistForReleasedSlot).toHaveBeenCalledTimes(1);
      expect(syncTurnoCancelled).toHaveBeenCalledTimes(1);
      expect(syncTurnoCancelledForPaciente).toHaveBeenCalledTimes(1);
    });

    it('returns success for an already cancelled appointment without side effects', async () => {
      const cancelledTurno = makePatchTurno('CANCELADO');
      mockPrisma.turno.findUnique
        .mockResolvedValueOnce(cancelledTurno)
        .mockResolvedValueOnce(cancelledTurno);

      const res = await request(app)
        .patch('/turnos/turno-1')
        .set('Authorization', `Bearer ${tokenFor('PROFESIONAL')}`)
        .send({ estado: 'CANCELADO' })
        .timeout({ deadline: 1000 });

      expect(res.status).toBe(200);
      expect(mockPrisma.turno.updateMany).not.toHaveBeenCalled();
      expectNoCancellationSideEffects();
    });

    it('returns success without side effects when another request already cancelled it', async () => {
      const activeTurno = makePatchTurno('RESERVADO');
      const cancelledTurno = { ...activeTurno, estado: 'CANCELADO' };
      mockPrisma.turno.findUnique
        .mockResolvedValueOnce(activeTurno)
        .mockResolvedValueOnce(cancelledTurno);
      mockPrisma.turno.updateMany.mockResolvedValue({ count: 0 });

      const res = await request(app)
        .patch('/turnos/turno-1')
        .set('Authorization', `Bearer ${tokenFor('PROFESIONAL')}`)
        .send({ estado: 'CANCELADO' })
        .timeout({ deadline: 1000 });

      expect(res.status).toBe(200);
      expect(mockPrisma.turno.updateMany).toHaveBeenCalledTimes(1);
      expectNoCancellationSideEffects();
    });

    it('returns an invalid transition when the atomic cancel loses to another terminal state', async () => {
      const activeTurno = makePatchTurno('RESERVADO');
      const completedTurno = { ...activeTurno, estado: 'COMPLETADO' };
      mockPrisma.turno.findUnique
        .mockResolvedValueOnce(activeTurno)
        .mockResolvedValueOnce(completedTurno);
      mockPrisma.turno.updateMany.mockResolvedValue({ count: 0 });

      const res = await request(app)
        .patch('/turnos/turno-1')
        .set('Authorization', `Bearer ${tokenFor('PROFESIONAL')}`)
        .send({ estado: 'CANCELADO' })
        .timeout({ deadline: 1000 });

      expect(res.status).toBe(409);
      expect(res.body.error?.code).toBe('INVALID_STATE_TRANSITION');
      expectNoCancellationSideEffects();
    });

    it('keeps patient cancellation-window validation before atomic cancellation', async () => {
      const soonTurno = makePatchTurno('RESERVADO', new Date(Date.now() + 60 * 60 * 1000));
      mockPrisma.turno.findUnique.mockResolvedValueOnce(soonTurno);

      const res = await request(app)
        .patch('/turnos/turno-1')
        .set('Authorization', `Bearer ${tokenFor('PACIENTE')}`)
        .send({ estado: 'CANCELADO' })
        .timeout({ deadline: 1000 });

      expect(res.status).toBe(422);
      expect(res.body.error?.code).toBe('CANCELLATION_WINDOW_EXCEEDED');
      expect(mockPrisma.turno.updateMany).not.toHaveBeenCalled();
      expectNoCancellationSideEffects();
    });
  });

  describe('Reprogramming modality side effects', () => {
    it('acquires the target professional-day advisory lock before reprogramming conflict reads', async () => {
      const { newDate } = setReprogramHappyPathMocks({
        currentModalidad: 'PRESENCIAL',
      });

      const res = await request(app)
        .post('/turnos/turno-1/reprogramar')
        .set('Authorization', `Bearer ${tokenFor('PROFESIONAL')}`)
        .send({ fechaHora: newDate.toISOString(), modalidad: 'PRESENCIAL' })
        .timeout({ deadline: 1000 });

      expect(res.status).toBe(200);
      expect(mockTx.$executeRaw).toHaveBeenCalledTimes(1);
      expect(mockTx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
        mockTx.turno.findMany.mock.invocationCallOrder[0]
      );
    });

    it('persists no external video link and clears location when changing from in-person to virtual', async () => {
      const { newDate } = setReprogramHappyPathMocks({
        currentModalidad: 'PRESENCIAL',
      });

      const res = await request(app)
        .post('/turnos/turno-1/reprogramar')
        .set('Authorization', `Bearer ${tokenFor('PROFESIONAL')}`)
        .send({ fechaHora: newDate.toISOString(), modalidad: 'VIRTUAL' })
        .timeout({ deadline: 1000 });

      expect(res.status).toBe(200);
      expect(mockTx.turno.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          modalidad: 'VIRTUAL',
          linkVideollamada: null,
          lugarAtencion: null,
        }),
      }));
    });

    it('clears video link and sets resolved location when changing from virtual to in-person', async () => {
      const { newDate } = setReprogramHappyPathMocks({
        currentModalidad: 'VIRTUAL',
        currentLinkVideollamada: 'https://meet.jit.si/MediSync-existing',
      });

      const res = await request(app)
        .post('/turnos/turno-1/reprogramar')
        .set('Authorization', `Bearer ${tokenFor('PROFESIONAL')}`)
        .send({ fechaHora: newDate.toISOString(), modalidad: 'PRESENCIAL' })
        .timeout({ deadline: 1000 });

      expect(res.status).toBe(200);
      expect(mockTx.turno.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          modalidad: 'PRESENCIAL',
          linkVideollamada: null,
          lugarAtencion: 'Consultorio disponibilidad',
        }),
      }));
    });

    it('clears any legacy video link when staying virtual (native WebRTC)', async () => {
      const { newDate } = setReprogramHappyPathMocks({
        currentModalidad: 'VIRTUAL',
        currentLinkVideollamada: 'https://meet.jit.si/MediSync-existing',
      });

      const res = await request(app)
        .post('/turnos/turno-1/reprogramar')
        .set('Authorization', `Bearer ${tokenFor('PROFESIONAL')}`)
        .send({ fechaHora: newDate.toISOString(), modalidad: 'VIRTUAL' })
        .timeout({ deadline: 1000 });

      expect(res.status).toBe(200);
      expect(mockTx.turno.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          modalidad: 'VIRTUAL',
          linkVideollamada: null,
          lugarAtencion: null,
        }),
      }));
    });

    it('keeps no video link and falls back to professional location when staying in-person', async () => {
      const { newDate } = setReprogramHappyPathMocks({
        currentModalidad: 'PRESENCIAL',
        disponibilidadLugar: null,
        profesionalLugar: 'Consultorio central',
      });

      const res = await request(app)
        .post('/turnos/turno-1/reprogramar')
        .set('Authorization', `Bearer ${tokenFor('PROFESIONAL')}`)
        .send({ fechaHora: newDate.toISOString(), modalidad: 'PRESENCIAL' })
        .timeout({ deadline: 1000 });

      expect(res.status).toBe(200);
      expect(mockTx.turno.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          modalidad: 'PRESENCIAL',
          linkVideollamada: null,
          lugarAtencion: 'Consultorio central',
        }),
      }));
    });
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

    it('acquires the professional-day advisory lock before legacy guest confirmation conflict reads', async () => {
      process.env.ENABLE_GUEST_BOOKING = 'true';

      const date = futureSlot();
      const token = 'a'.repeat(32);
      mockPrisma.bookingVerification.findUnique.mockResolvedValue({
        token,
        email: 'guest@test.com',
        nombre: 'Juan',
        apellido: 'Perez',
        telefonoPaciente: '123456789',
        profesionalId,
        fechaHora: date,
        modalidad: 'PRESENCIAL',
        expiresAt: new Date(Date.now() + 60_000),
      });
      mockPrisma.paciente.findFirst.mockResolvedValue({ id: pacienteId });
      mockTx.turno.findMany.mockResolvedValue([]);
      mockTx.turno.create.mockResolvedValue({
        id: 'turno-guest-1',
        profesionalId,
        pacienteId,
        fechaHora: date,
        modalidad: 'PRESENCIAL',
        duracionMin: 30,
        estado: 'RESERVADO',
      });
      mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockTx));
      mockPrisma.bookingVerification.delete.mockResolvedValue({});

      const res = await request(app)
        .post('/turnos/confirmar-reserva')
        .send({ token })
        .timeout({ deadline: 1000 });

      expect(res.status).toBe(200);
      expect(mockTx.$executeRaw).toHaveBeenCalledTimes(1);
      expect(mockTx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
        mockTx.turno.findMany.mock.invocationCallOrder[0]
      );
    });
  });

  describe('POST /turnos/:id/receta', () => {
    it('formats prescription share text and patient notification dates in clinic timezone', async () => {
      const fechaHora = new Date('2026-06-01T02:30:00.000Z');
      const emitidaAt = new Date('2026-06-01T02:30:00.000Z');

      mockPrisma.turno.findUnique.mockResolvedValue({
        id: 'turno-receta-1',
        estado: 'CONFIRMADO',
        fechaHora,
        profesional: {
          usuarioId: profesionalUsuarioId,
          nombre: 'Franco',
          apellido: 'Pedretti',
          matricula: 'MP123',
          especialidad: { nombre: 'Clinica medica' },
        },
        paciente: {
          nombre: 'Paciente',
          apellido: 'Prueba',
          email: 'paciente@test.com',
        },
      });
      mockPrisma.recetaIndicacion.upsert.mockResolvedValue({
        id: 'receta-1',
        turnoId: 'turno-receta-1',
        diagnostico: 'Diagnostico de prueba',
        planTratamiento: null,
        medicamentos: null,
        indicaciones: 'Indicaciones de prueba',
        estudiosSolicitados: null,
        proximoControl: null,
        advertencias: null,
        observaciones: null,
        emitidaAt,
      });
      mockPrisma.paciente.findFirst.mockResolvedValue({
        usuarioId: pacienteUsuarioId,
        notifEmail: true,
        notifWhatsapp: false,
        telefono: null,
      });

      const res = await request(app)
        .post('/turnos/turno-receta-1/receta')
        .set('Authorization', `Bearer ${tokenFor('PROFESIONAL')}`)
        .send({
          diagnostico: 'Diagnostico de prueba',
          indicaciones: 'Indicaciones de prueba',
        })
        .timeout({ deadline: 1000 });

      expect(res.status).toBe(201);
      expect(res.body.data.shareText).toContain('Fecha atencion: 31/5/2026 23:30');
      expect(res.body.data.shareText).not.toContain('Fecha atencion: 1/6/2026');
      expect(res.body.data.shareText).toContain('Emitida: 31/5/2026');
      expect(res.body.data.shareText).toContain('23:30');
      expect(res.body.data.shareText).not.toContain('Emitida: 1/6/2026');

      expect(sendNotification).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({
        message: expect.stringContaining('consulta del 31/5/2026'),
        meta: expect.objectContaining({
          fechaHora: fechaHora.toISOString(),
        }),
      }));
      expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({
        cuerpo: expect.stringContaining('consulta del 31/5/2026'),
      }));
    });
  });
});
