/**
 * Google Calendar OAuth routes
 * GET  /api/google/auth-url   → returns the consent URL (profesional or paciente)
 * GET  /api/google/callback   → Google redirects here after consent
 * DELETE /api/google/disconnect → revoke & clear token
 * GET  /api/google/status     → is the user connected?
 */
import { Router } from 'express';
import prisma from '../lib/prisma';
import { asyncHandler, success, AppError } from '../utils/response';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';
import { getAuthUrl, exchangeCode, createOAuthClient } from '../services/google-calendar.service';

const router = Router();

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// ── GET /api/google/auth-url ─────────────────────────────────────────────────
// State encodes userId|rol so the callback can redirect to the correct dashboard.
router.get('/auth-url', authMiddleware, asyncHandler(async (req: AuthRequest, res) => {
  const { userId, rol } = req.user!;
  if (rol !== 'PROFESIONAL' && rol !== 'PACIENTE') {
    throw new AppError(403, 'FORBIDDEN', 'Solo profesionales y pacientes pueden conectar Google Calendar');
  }

  const state = `${userId}|${rol}`;
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

  // Support legacy state (just userId) and new state (userId|rol)
  const [userId, rol = 'PROFESIONAL'] = state.split('|');
  const basePath = rol === 'PACIENTE' ? '/dashboard/paciente' : '/dashboard';

  try {
    const tokens = await exchangeCode(code);

    await prisma.usuario.update({
      where: { id: userId },
      data: { googleToken: JSON.stringify(tokens) },
    });

    return res.redirect(`${FRONTEND_URL}${basePath}?google=connected`);
  } catch (err) {
    console.error('[Google callback error]', err);
    return res.redirect(`${FRONTEND_URL}${basePath}?google=error`);
  }
}));

// ── DELETE /api/google/disconnect ────────────────────────────────────────────
router.delete('/disconnect', authMiddleware, asyncHandler(async (req: AuthRequest, res) => {
  const usuario = await prisma.usuario.findUnique({ where: { id: req.user!.userId } });
  if (!usuario) throw new AppError(404, 'NOT_FOUND', 'Usuario no encontrado');

  if (usuario.googleToken) {
    try {
      const client = createOAuthClient();
      const tokens = JSON.parse(usuario.googleToken);
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
router.get('/status', authMiddleware, asyncHandler(async (req: AuthRequest, res) => {
  const usuario = await prisma.usuario.findUnique({
    where: { id: req.user!.userId },
    select: { googleToken: true },
  });

  res.json(success({ connected: Boolean(usuario?.googleToken) }));
}));

export { router as googleRouter };
