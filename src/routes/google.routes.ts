/**
 * Google Calendar OAuth routes
 * GET  /api/google/auth-url   → returns the consent URL (profesional or paciente)
 * GET  /api/google/callback   → Google redirects here after consent
 * DELETE /api/google/disconnect → revoke & clear token
 * GET  /api/google/status     → is the user connected?
 */
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../lib/prisma';
import { asyncHandler, success, AppError } from '../utils/response';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';
import { getAuthUrl, exchangeCode, createOAuthClient } from '../services/google-calendar.service';
import { encryptSecret, decryptSecret } from '../utils/crypto';

const router = Router();

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

type OAuthStatePayload = { userId: string; rol: 'PROFESIONAL' | 'PACIENTE' };

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET no configurado');
  return secret;
}

// The OAuth `state` is a short-lived JWT signed with JWT_SECRET. Because /auth-url
// is authenticated, the state can only ever carry the caller's own userId — an
// attacker cannot forge a state binding their Google code to a victim's account.
function signOAuthState(payload: OAuthStatePayload): string {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: '10m' });
}

function verifyOAuthState(state: string): OAuthStatePayload | null {
  try {
    const decoded = jwt.verify(state, getJwtSecret()) as Partial<OAuthStatePayload>;
    if (!decoded.userId || (decoded.rol !== 'PROFESIONAL' && decoded.rol !== 'PACIENTE')) {
      return null;
    }
    return { userId: decoded.userId, rol: decoded.rol };
  } catch {
    return null;
  }
}

// ── GET /api/google/auth-url ─────────────────────────────────────────────────
// State encodes userId|rol so the callback can redirect to the correct dashboard.
router.get('/auth-url', authMiddleware(), asyncHandler(async (req: AuthRequest, res) => {
  const { userId, rol } = req.user!;
  if (rol !== 'PROFESIONAL' && rol !== 'PACIENTE') {
    throw new AppError(403, 'FORBIDDEN', 'Solo profesionales y pacientes pueden conectar Google Calendar');
  }

  const state = signOAuthState({ userId, rol });
  const url = getAuthUrl(state);
  res.json(success({ url }));
}));

// ── GET /api/google/callback ─────────────────────────────────────────────────
// Google redirects here with ?code=...&state=userId|rol
router.get('/callback', asyncHandler(async (req, res) => {
  const { code, state, error: oauthError } = req.query as Record<string, string>;

  if (oauthError || !code || !state) {
    return res.redirect(`${FRONTEND_URL}/dashboard?google=error`);
  }

  // State must be a valid, unexpired, server-signed token. Reject forged states.
  const verifiedState = verifyOAuthState(state);
  if (!verifiedState) {
    return res.redirect(`${FRONTEND_URL}/dashboard?google=error`);
  }
  const { userId, rol } = verifiedState;
  const basePath = rol === 'PACIENTE' ? '/dashboard/paciente' : '/dashboard';

  try {
    const tokens = await exchangeCode(code);

    await prisma.usuario.update({
      where: { id: userId },
      data: { googleToken: encryptSecret(JSON.stringify(tokens)) },
    });

    return res.redirect(`${FRONTEND_URL}${basePath}?google=connected`);
  } catch (err) {
    console.error('[Google callback error]', err);
    return res.redirect(`${FRONTEND_URL}${basePath}?google=error`);
  }
}));

// ── DELETE /api/google/disconnect ────────────────────────────────────────────
router.delete('/disconnect', authMiddleware(), asyncHandler(async (req: AuthRequest, res) => {
  const usuario = await prisma.usuario.findUnique({ where: { id: req.user!.userId } });
  if (!usuario) throw new AppError(404, 'NOT_FOUND', 'Usuario no encontrado');

  if (usuario.googleToken) {
    try {
      const client = createOAuthClient();
      const tokens = JSON.parse(decryptSecret(usuario.googleToken));
      client.setCredentials(tokens);
      await client.revokeCredentials();
    } catch {
      // If revocation fails (expired token) we still clear locally
    }
  }

  await prisma.usuario.update({
    where: { id: req.user!.userId },
    data: { googleToken: null },
  });

  res.json(success({ disconnected: true }));
}));

// ── GET /api/google/status ───────────────────────────────────────────────────
router.get('/status', authMiddleware(), asyncHandler(async (req: AuthRequest, res) => {
  const usuario = await prisma.usuario.findUnique({
    where: { id: req.user!.userId },
    select: { googleToken: true },
  });

  res.json(success({ connected: Boolean(usuario?.googleToken) }));
}));

export { router as googleRouter };
