import { describe, expect, it, afterEach } from '@jest/globals';
import jwt from 'jsonwebtoken';
import { createVideoAccess } from '../services/livekit.service';

const ORIGINAL_ENV = { ...process.env };

describe('createVideoAccess', () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('throws VIDEO_NOT_CONFIGURED when LiveKit env vars are missing', async () => {
    delete process.env.LIVEKIT_URL;
    delete process.env.LIVEKIT_API_KEY;
    delete process.env.LIVEKIT_API_SECRET;

    await expect(createVideoAccess('turno-1', 'user-1', 'Paciente')).rejects.toMatchObject({
      statusCode: 503,
      code: 'VIDEO_NOT_CONFIGURED',
    });
  });

  it('mints a JWT signed with the api secret, scoped to the turno room', async () => {
    process.env.LIVEKIT_URL = 'wss://livekit.example';
    process.env.LIVEKIT_API_KEY = 'devkey';
    process.env.LIVEKIT_API_SECRET = 'devsecret-0123456789-0123456789';

    const access = await createVideoAccess('turno-1', 'user-1', 'Paciente');

    expect(access.url).toBe('wss://livekit.example');
    expect(access.roomName).toBe('turno-1');

    // The token must verify against the secret and carry a room-scoped grant.
    const decoded = jwt.verify(access.token, 'devsecret-0123456789-0123456789') as any;
    expect(decoded.sub).toBe('user-1');
    expect(decoded.video?.room).toBe('turno-1');
    expect(decoded.video?.roomJoin).toBe(true);
  });
});
