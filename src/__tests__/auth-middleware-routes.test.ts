import express from 'express';
import request from 'supertest';
import { describe, expect, it } from '@jest/globals';
import { generateToken } from '../middleware/auth.middleware';
import { chatRouter } from '../routes/chat.routes';
import { googleRouter } from '../routes/google.routes';
import { turnosRouter } from '../routes/turnos.routes';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/chat', chatRouter);
  app.use('/google', googleRouter);
  app.use('/turnos', turnosRouter);
  return app;
}

describe('auth-protected route middleware', () => {
  const app = makeApp();
  const deadline = { deadline: 500 };

  it('rejects unauthenticated chat requests without hanging', async () => {
    const res = await request(app).get('/chat/some-turno-id').timeout(deadline);

    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('UNAUTHORIZED');
  });

  it('rejects unauthenticated Google auth URL requests without hanging', async () => {
    const res = await request(app).get('/google/auth-url').timeout(deadline);

    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('UNAUTHORIZED');
  });

  it('rejects unauthenticated Google status requests without hanging', async () => {
    const res = await request(app).get('/google/status').timeout(deadline);

    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('UNAUTHORIZED');
  });

  it('rejects unauthenticated Google disconnect requests without hanging', async () => {
    const res = await request(app).delete('/google/disconnect').timeout(deadline);

    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('UNAUTHORIZED');
  });

  it('rejects unauthenticated appointment booking before reaching booking logic', async () => {
    const res = await request(app)
      .post('/turnos/reservar')
      .send({
        profesionalId: '00000000-0000-0000-0000-000000000001',
        fechaHora: new Date(Date.now() + 86_400_000).toISOString(),
        modalidad: 'PRESENCIAL',
      })
      .timeout(deadline);

    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('UNAUTHORIZED');
  });

  it('rejects non-patient appointment booking before reaching booking logic', async () => {
    const token = generateToken({
      userId: '00000000-0000-0000-0000-000000000001',
      email: 'doctor@test.com',
      rol: 'PROFESIONAL',
    });

    const res = await request(app)
      .post('/turnos/reservar')
      .set('Authorization', `Bearer ${token}`)
      .send({
        profesionalId: '00000000-0000-0000-0000-000000000001',
        fechaHora: new Date(Date.now() + 86_400_000).toISOString(),
        modalidad: 'PRESENCIAL',
      })
      .timeout(deadline);

    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('FORBIDDEN');
  });
});
