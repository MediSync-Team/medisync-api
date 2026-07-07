import express from 'express';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { errorHandler } from '../middleware/error.middleware';

const mockPrisma = {
  usuario: {
    findUnique: jest.fn() as any,
    update: jest.fn() as any,
  },
};

jest.mock('../lib/prisma', () => ({
  __esModule: true,
  default: mockPrisma,
}));

import { authRouter } from '../routes/auth.routes';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/auth', authRouter);
  app.use(errorHandler);
  return app;
}

describe('auth login route lockout handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('clears failed login and lockout fields on successful login', async () => {
    const passwordHash = await bcrypt.hash('Password123!', 4);
    mockPrisma.usuario.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'tester@example.com',
      rol: 'PACIENTE',
      passwordHash,
      failedLoginAttempts: 7,
      lockedUntil: null,
      lastFailedLoginAt: new Date('2026-07-07T12:00:00.000Z'),
      paciente: { id: 'paciente-1' },
      profesional: null,
    });
    mockPrisma.usuario.update.mockResolvedValue({});

    const res = await request(makeApp())
      .post('/auth/login')
      .send({ email: 'tester@example.com', password: 'Password123!' });

    expect(res.status).toBe(200);
    expect(mockPrisma.usuario.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: {
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastFailedLoginAt: null,
      },
    });
  });
});
