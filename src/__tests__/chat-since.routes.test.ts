import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { generateToken } from '../middleware/auth.middleware';

const pacienteUsuarioId = '22222222-2222-4222-8222-222222222222';
const profesionalUsuarioId = '11111111-1111-4111-8111-111111111111';
const turnoId = '33333333-3333-4333-8333-333333333333';

const mockPrisma = {
  turno: {
    findUnique: jest.fn() as any,
  },
  chatMensaje: {
    findMany: jest.fn() as any,
    updateMany: jest.fn() as any,
  },
};

jest.mock('../lib/prisma', () => ({
  __esModule: true,
  default: mockPrisma,
}));

import { chatRouter } from '../routes/chat.routes';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/chat', chatRouter);
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err.statusCode || 500).json({
      success: false,
      error: { code: err.code || 'INTERNAL_ERROR', message: err.message },
    });
  });
  return app;
}

function pacienteToken() {
  return generateToken({ userId: pacienteUsuarioId, email: 'paciente@test.com', rol: 'PACIENTE' });
}

const turnoDeAcceso = {
  id: turnoId,
  estado: 'CONFIRMADO',
  paciente: { id: 'pac-1', nombre: 'Ana', apellido: 'Perez', usuarioId: pacienteUsuarioId },
  profesional: { id: 'prof-1', nombre: 'Dr', apellido: 'House', usuarioId: profesionalUsuarioId },
};

describe('GET /chat/:turnoId (since param)', () => {
  const app = makeApp();

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.turno.findUnique.mockResolvedValue(turnoDeAcceso as any);
    mockPrisma.chatMensaje.findMany.mockResolvedValue([]);
    mockPrisma.chatMensaje.updateMany.mockResolvedValue({ count: 0 } as any);
  });

  it('without since, returns the full last-200 behavior (no createdAt filter)', async () => {
    const res = await request(app)
      .get(`/chat/${turnoId}`)
      .set('Authorization', `Bearer ${pacienteToken()}`);

    expect(res.status).toBe(200);
    expect(mockPrisma.chatMensaje.findMany).toHaveBeenCalledWith({
      where: { turnoId },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
  });

  it('with a valid since, filters createdAt greater than that timestamp', async () => {
    const since = '2026-05-18T15:00:00.000Z';
    const res = await request(app)
      .get(`/chat/${turnoId}`)
      .query({ since })
      .set('Authorization', `Bearer ${pacienteToken()}`);

    expect(res.status).toBe(200);
    expect(mockPrisma.chatMensaje.findMany).toHaveBeenCalledWith({
      where: { turnoId, createdAt: { gt: new Date(since) } },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
  });

  it('with an invalid since, falls back to the unfiltered behavior instead of erroring', async () => {
    const res = await request(app)
      .get(`/chat/${turnoId}`)
      .query({ since: 'not-a-date' })
      .set('Authorization', `Bearer ${pacienteToken()}`);

    expect(res.status).toBe(200);
    expect(mockPrisma.chatMensaje.findMany).toHaveBeenCalledWith({
      where: { turnoId },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
  });

  it('marks only unread incoming messages as read, regardless of since', async () => {
    mockPrisma.chatMensaje.findMany.mockResolvedValue([
      { id: 'msg-1', remitenteId: profesionalUsuarioId, contenido: 'hola', leidoAt: null, createdAt: new Date() },
      { id: 'msg-2', remitenteId: pacienteUsuarioId, contenido: 'ya leido', leidoAt: new Date(), createdAt: new Date() },
      { id: 'msg-3', remitenteId: pacienteUsuarioId, contenido: 'mio, no leido pero es mio', leidoAt: null, createdAt: new Date() },
    ] as any);

    const res = await request(app)
      .get(`/chat/${turnoId}`)
      .set('Authorization', `Bearer ${pacienteToken()}`);

    expect(res.status).toBe(200);
    expect(mockPrisma.chatMensaje.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['msg-1'] } },
      data: { leidoAt: expect.any(Date) },
    });
  });
});
