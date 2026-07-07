import express from 'express';
import request from 'supertest';
import { describe, expect, it } from '@jest/globals';
import { createLoginRateLimiter } from '../middleware/rate-limiters';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.post('/auth/login', createLoginRateLimiter(), (req, res) => {
    if (req.body.password === 'ok') {
      res.json({ success: true });
      return;
    }
    res.status(401).json({ success: false, error: { code: 'INVALID_CREDENTIALS', message: 'Credenciales inválidas' } });
  });
  app.get('/auth/me', (_req, res) => {
    res.json({ success: true, data: { id: 'user-1' } });
  });
  return app;
}

describe('auth rate limiters', () => {
  it('does not apply the login limiter to /auth/me', async () => {
    const app = makeApp();

    for (let i = 0; i < 65; i += 1) {
      const res = await request(app).get('/auth/me');
      expect(res.status).toBe(200);
    }
  });

  it('returns RATE_LIMIT_LOGIN after repeated failed login attempts', async () => {
    const app = makeApp();
    let res = await request(app).post('/auth/login').send({ email: 'test@example.com', password: 'bad' });

    expect(res.status).toBe(401);

    for (let i = 0; i < 60; i += 1) {
      res = await request(app).post('/auth/login').send({ email: 'test@example.com', password: 'bad' });
    }

    expect(res.status).toBe(429);
    expect(res.body.error?.code).toBe('RATE_LIMIT_LOGIN');
  });

  it('does not count successful logins against the failed-login limiter', async () => {
    const app = makeApp();

    for (let i = 0; i < 65; i += 1) {
      const success = await request(app).post('/auth/login').send({ email: 'test@example.com', password: 'ok' });
      expect(success.status).toBe(200);
    }

    const failed = await request(app).post('/auth/login').send({ email: 'test@example.com', password: 'bad' });

    expect(failed.status).toBe(401);
    expect(failed.body.error?.code).toBe('INVALID_CREDENTIALS');
  });
});
