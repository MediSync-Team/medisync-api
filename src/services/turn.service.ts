/**
 * ICE server resolution for WebRTC video calls.
 *
 * STUN alone cannot relay media across two NATs (symmetric NAT / UDP-blocked
 * networks), so cross-network calls need a TURN relay. We use Cloudflare Realtime
 * TURN and mint short-lived ephemeral credentials per call, so no long-lived TURN
 * secret ever ships in the public web/mobile bundle.
 *
 * If Cloudflare env vars are absent (e.g. local dev), we fall back to STUN-only —
 * same-network calls keep working and call setup never breaks.
 */

/** A WebRTC ICE server entry (the backend has no DOM lib, so we type it locally). */
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** Public Google STUN servers — always included as the discovery baseline. */
export const STUN_SERVERS: IceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];

const CLOUDFLARE_TURN_API = 'https://rtc.live.cloudflare.com/v1/turn/keys';

interface CloudflareTurnResponse {
  iceServers: {
    urls: string[];
    username?: string;
    credential?: string;
  }[];
}

export function summarizeIceServers(servers: IceServer[]): string {
  const counts = { stun: 0, turn: 0, turns: 0, other: 0 };
  for (const server of servers) {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    for (const url of urls) {
      const scheme = String(url).split(':')[0] as keyof typeof counts;
      if (scheme in counts) counts[scheme] += 1;
      else counts.other += 1;
    }
  }
  return `servers=${servers.length} stun=${counts.stun} turn=${counts.turn} turns=${counts.turns} other=${counts.other}`;
}

function logIceServers(kind: 'stun-only' | 'stun-turn', servers: IceServer[]) {
  console.info(`[turn] ICE servers resolved (${kind}): ${summarizeIceServers(servers)}`);
}

/**
 * Resolve the ICE servers to hand to a client for a call.
 * Returns STUN + a Cloudflare TURN entry with ephemeral credentials when
 * configured; STUN-only otherwise.
 */
export async function getIceServers(): Promise<IceServer[]> {
  const tokenId = process.env.CLOUDFLARE_TURN_TOKEN_ID;
  const apiToken = process.env.CLOUDFLARE_TURN_API_TOKEN;

  if (!tokenId || !apiToken) {
    logIceServers('stun-only', STUN_SERVERS);
    return STUN_SERVERS;
  }

  const ttl = Number(process.env.TURN_TTL_SECONDS) || 3600;

  try {
    const res = await fetch(
      `${CLOUDFLARE_TURN_API}/${tokenId}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl }),
      },
    );

    if (!res.ok) {
      console.warn(
        `[turn] Cloudflare TURN credential request failed (${res.status}); falling back to STUN-only`,
      );
      logIceServers('stun-only', STUN_SERVERS);
      return STUN_SERVERS;
    }

    const data = (await res.json()) as CloudflareTurnResponse;
    if (!data?.iceServers?.length) {
      console.warn('[turn] Cloudflare TURN response missing iceServers; falling back to STUN-only');
      logIceServers('stun-only', STUN_SERVERS);
      return STUN_SERVERS;
    }

    const servers = [...STUN_SERVERS, ...data.iceServers];
    logIceServers('stun-turn', servers);
    return servers;
  } catch (err) {
    console.warn('[turn] Error fetching Cloudflare TURN credentials; falling back to STUN-only', err);
    logIceServers('stun-only', STUN_SERVERS);
    return STUN_SERVERS;
  }
}
