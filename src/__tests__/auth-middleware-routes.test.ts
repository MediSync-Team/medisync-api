import express from 'express';
import request from 'supertest';
import { describe, expect, it } from '@jest/globals';
import { chatRouter } from '../routes/chat.routes';
import { googleRouter } from '../routes/google.routes';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/chat', chatRouter);
  app.use('/google', googleRouter);
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
});
