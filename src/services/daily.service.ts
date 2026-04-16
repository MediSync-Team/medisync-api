/**
 * Daily.co integration service.
 *
 * Required env vars:
 *   DAILY_API_KEY   — API key from your Daily.co dashboard
 *   DAILY_DOMAIN    — Your Daily subdomain, e.g. "medisync" → rooms at medisync.daily.co
 *
 * If DAILY_API_KEY is not set the service returns null (graceful degradation).
 */

const DAILY_BASE = 'https://api.daily.co/v1';

function apiKey(): string | null {
  return process.env.DAILY_API_KEY ?? null;
}

function domain(): string {
  return process.env.DAILY_DOMAIN ?? '';
}

function headers() {
  return {
    Authorization: `Bearer ${apiKey()}`,
    'Content-Type': 'application/json',
  };
}

export interface DailyRoom {
  id: string;
  name: string;
  url: string;    // e.g. https://medisync.daily.co/roomname
  exp: number;    // unix timestamp
}

export interface DailyToken {
  token: string;
  joinUrl: string; // url + ?t=token
}

/**
 * Create a Daily room for a VIRTUAL turno.
 * @param roomName  Unique identifier (we use turnoId, slug-safe)
 * @param expiresAt When the room should expire (turno time + buffer)
 */
export async function createDailyRoom(
  roomName: string,
  expiresAt: Date,
): Promise<DailyRoom | null> {
  if (!apiKey()) {
    console.warn('[daily] DAILY_API_KEY not set — skipping room creation');
    return null;
  }

  const exp = Math.floor(expiresAt.getTime() / 1000);

  const res = await fetch(`${DAILY_BASE}/rooms`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      name: roomName,
      privacy: 'private',         // requires a token to join
      properties: {
        exp,
        eject_at_token_exp: true, // kick everyone when token expires
        max_participants: 2,
        enable_chat: true,
        enable_screenshare: false,
        start_audio_off: false,
        start_video_off: false,
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error('[daily] createRoom error:', res.status, body);
    return null;
  }

  const data: any = await res.json();
  return {
    id: data.id,
    name: data.name,
    url: data.url,
    exp,
  };
}

/**
 * Generate a short-lived meeting token for a participant.
 * @param roomName  The room to join
 * @param isOwner   Profesional gets owner privileges (mute others, end call)
 * @param expiresAt Token expiry (usually same as room expiry)
 * @param userName  Display name shown in the call
 */
export async function createDailyToken(
  roomName: string,
  isOwner: boolean,
  expiresAt: Date,
  userName: string,
): Promise<DailyToken | null> {
  if (!apiKey()) return null;

  const exp = Math.floor(expiresAt.getTime() / 1000);

  const res = await fetch(`${DAILY_BASE}/meeting-tokens`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      properties: {
        room_name: roomName,
        is_owner: isOwner,
        exp,
        user_name: userName,
        enable_recording: false,
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error('[daily] createToken error:', res.status, body);
    return null;
  }

  const data: any = await res.json();
  const joinUrl = `${domain() ? `https://${domain()}.daily.co/${roomName}` : ''}?t=${data.token}`;

  return { token: data.token, joinUrl };
}

/**
 * Extract the room name from a Daily room URL.
 * https://medisync.daily.co/roomname → "roomname"
 */
export function roomNameFromUrl(url: string): string {
  return url.split('/').pop() ?? '';
}
