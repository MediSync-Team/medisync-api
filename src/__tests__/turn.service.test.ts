import { getIceServers, STUN_SERVERS } from '../services/turn.service';

describe('getIceServers', () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;

  afterEach(() => {
    process.env = { ...originalEnv };
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('returns STUN-only when Cloudflare TURN env is not configured', async () => {
    delete process.env.CLOUDFLARE_TURN_TOKEN_ID;
    delete process.env.CLOUDFLARE_TURN_API_TOKEN;

    const servers = await getIceServers();
    expect(servers).toEqual(STUN_SERVERS);
  });

  it('appends a Cloudflare TURN entry with ephemeral credentials when configured', async () => {
    process.env.CLOUDFLARE_TURN_TOKEN_ID = 'token-id';
    process.env.CLOUDFLARE_TURN_API_TOKEN = 'api-token';

    const turnEntry = {
      urls: ['turn:turn.cloudflare.com:3478', 'turns:turn.cloudflare.com:5349?transport=tcp'],
      username: 'ephemeral-user',
      credential: 'ephemeral-secret',
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ iceServers: turnEntry }),
    }) as unknown as typeof fetch;

    const servers = await getIceServers();
    expect(servers).toHaveLength(STUN_SERVERS.length + 1);
    expect(servers[servers.length - 1]).toEqual(turnEntry);
    const last = servers[servers.length - 1].urls;
    const urls = Array.isArray(last) ? last : [last];
    expect(urls.some((u) => u.startsWith('turn'))).toBe(true);
  });

  it('falls back to STUN-only when the Cloudflare request fails', async () => {
    process.env.CLOUDFLARE_TURN_TOKEN_ID = 'token-id';
    process.env.CLOUDFLARE_TURN_API_TOKEN = 'api-token';
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof fetch;
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    const servers = await getIceServers();
    expect(servers).toEqual(STUN_SERVERS);
  });
});
