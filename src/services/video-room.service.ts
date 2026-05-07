/**
 * Native WebRTC signaling service.
 * Manages in-memory rooms keyed by turnoId.
 * Each room holds at most 2 peers (1-on-1 video consultation).
 *
 * Ticket flow:
 *   1. Client calls GET /turnos/:id/video-token (authenticated) → receives a short-lived ticket
 *   2. Client opens WebSocket to /ws/video?ticket=<ticket>
 *   3. Server validates ticket, places client in the room, relays WebRTC signaling
 */

import WebSocket from 'ws';
import crypto from 'crypto';

// ─── Tickets ──────────────────────────────────────────────────────────────────

interface Ticket {
  turnoId: string;
  userId: string;
  expiresAt: number;
}

const ticketStore = new Map<string, Ticket>();

/** Issue a one-time ticket valid for 90 seconds. */
export function issueVideoTicket(turnoId: string, userId: string): string {
  const ticket = crypto.randomBytes(20).toString('hex');
  ticketStore.set(ticket, { turnoId, userId, expiresAt: Date.now() + 90_000 });
  return ticket;
}

function consumeTicket(ticket: string): Ticket | null {
  const t = ticketStore.get(ticket);
  ticketStore.delete(ticket); // one-time use
  if (!t || t.expiresAt < Date.now()) return null;
  return t;
}

// Cleanup expired tickets every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of ticketStore) {
    if (v.expiresAt < now) ticketStore.delete(k);
  }
}, 5 * 60_000);

// ─── Rooms ────────────────────────────────────────────────────────────────────

interface Peer {
  ws: WebSocket;
  userId: string;
}

const rooms = new Map<string, Set<Peer>>();

function safeSend(ws: WebSocket, msg: object) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

/**
 * Called for every new WebSocket connection on /ws/video.
 * Validates the ticket, places the peer in the right room, and relays messages.
 */
export function handleVideoConnection(ws: WebSocket, ticket: string) {
  const ticketData = consumeTicket(ticket);
  if (!ticketData) {
    safeSend(ws, { type: 'error', message: 'Ticket inválido o expirado. Recargá la página.' });
    ws.close(4001, 'Unauthorized');
    return;
  }

  const { turnoId, userId } = ticketData;

  if (!rooms.has(turnoId)) rooms.set(turnoId, new Set());
  const room = rooms.get(turnoId)!;

  if (room.size >= 2) {
    safeSend(ws, { type: 'error', message: 'La sala ya está llena.' });
    ws.close(4002, 'Room full');
    return;
  }

  const peer: Peer = { ws, userId };
  room.add(peer);

  if (room.size === 1) {
    // First peer in the room — wait for the other
    safeSend(ws, { type: 'waiting' });
  } else {
    // Second peer joined — the new peer creates the offer (they are the "caller")
    const [waiting] = [...room].filter(p => p !== peer);
    safeSend(ws, { type: 'start-call' });           // tell new peer to create offer
    safeSend(waiting.ws, { type: 'peer-joined' });  // wake up waiting peer
  }

  // ── Relay signaling messages to the other peer ──
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      for (const other of room) {
        if (other !== peer) safeSend(other.ws, msg);
      }
    } catch {
      // ignore malformed messages
    }
  });

  ws.on('close', () => {
    room.delete(peer);
    for (const other of room) {
      safeSend(other.ws, { type: 'peer-left' });
    }
    if (room.size === 0) rooms.delete(turnoId);
  });

  ws.on('error', () => ws.close());
}
