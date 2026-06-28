/**
 * LiveKit access-token minting for video consultations.
 *
 * Replaces the previous in-memory WebRTC signaling (video-room.service) and the
 * STUN/TURN resolver (turn.service): media + signaling now run through the
 * LiveKit SFU, so the API only mints a short-lived access token scoped to the
 * turno's room and stays stateless for video (any instance can serve any call).
 *
 * If the LiveKit env vars are absent we throw VIDEO_NOT_CONFIGURED rather than
 * crashing at boot, mirroring the graceful-degradation style of the old code.
 */
import { AccessToken } from 'livekit-server-sdk';
import { AppError } from '../utils/response';

export interface VideoAccess {
  /** Signed LiveKit access token (JWT) the client uses to join the room. */
  token: string;
  /** LiveKit SFU websocket URL (wss://…) the client connects to. */
  url: string;
  /** Room name — one room per turno (the turnoId). */
  roomName: string;
}

/** Default token lifetime; covers a full consultation plus reconnects. */
const DEFAULT_TTL_SECONDS = 60 * 60; // 1h

/**
 * Mint a LiveKit access token for `userId` to join the room for `turnoId`.
 *
 * - identity = usuarioId (stable per user, so the SFU can dedupe/replace a stale
 *   connection if the same user rejoins)
 * - room     = turnoId (one room per appointment; max 2 participants in practice)
 * - grants   = publish + subscribe + data (data powers the in-call chat channel)
 */
export async function createVideoAccess(
  turnoId: string,
  userId: string,
  displayName: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<VideoAccess> {
  const url = process.env.LIVEKIT_URL;
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;

  if (!url || !apiKey || !apiSecret) {
    throw new AppError(
      503,
      'VIDEO_NOT_CONFIGURED',
      'El servicio de videollamada no está configurado',
    );
  }

  const at = new AccessToken(apiKey, apiSecret, {
    identity: userId,
    name: displayName,
    ttl: ttlSeconds,
  });

  at.addGrant({
    roomJoin: true,
    room: turnoId,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });

  // livekit-server-sdk v2: toJwt() is async.
  const token = await at.toJwt();
  return { token, url, roomName: turnoId };
}
