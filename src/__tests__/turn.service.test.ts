import { getIceServers, STUN_SERVERS, summarizeIceServers } from '../services/turn.service';

describe('getIceServers', () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;

  afterEach(() => {
    process.env = { ...originalEnv };
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    jest.spyOn(console, 'info').mockImplementation(() => {});
  });

  it('returns STUN-only when Cloudflare TURN env is not configured', async () => {
    delete process.env.CLOUDFLARE_TURN_TOKEN_ID;
    delete process.env.CLOUDFLARE_TURN_API_TOKEN;

    const servers = await getIceServers();
    expect(servers).toEqual(STUN_SERVERS);
    expect(console.info).toHaveBeenCalledWith('[turn] ICE servers resolved (stun-only): servers=3 stun=3 turn=0 turns=0 other=0');
  });

  it('appends a Cloudflare TURN entry with ephemeral credentials when configured', async () => {
    process.env.CLOUDFLARE_TURN_TOKEN_ID = 'token-id';
    process.env.CLOUDFLARE_TURN_API_TOKEN = 'api-token';

    const turnEntry = {
      urls: ['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:3478?transport=tcp', 'turns:turn.cloudflare.com:5349?transport=tcp'],
      username: 'ephemeral-user',
      credential: 'ephemeral-secret',
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ iceServers: [turnEntry] }),
    }) as unknown as typeof fetch;

    const servers = await getIceServers();
    expect(servers).toHaveLength(STUN_SERVERS.length + 1);
    expect(servers[servers.length - 1]).toEqual(turnEntry);
    expect(console.info).toHaveBeenCalledWith('[turn] ICE servers resolved (stun-turn): servers=4 stun=4 turn=2 turns=1 other=0');
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

  it('summarizes ICE servers without credentials or host details', () => {
    const summary = summarizeIceServers([
      { urls: 'stun:stun.example.com:19302' },
      { urls: ['turn:secret.example.com:3478', 'turns:secret.example.com:5349?transport=tcp'], username: 'user', credential: 'pass' },
    ]);

    expect(summary).toBe('servers=2 stun=1 turn=1 turns=1 other=0');
    expect(summary).not.toContain('user');
    expect(summary).not.toContain('pass');
    expect(summary).not.toContain('secret.example.com');
  });
});
