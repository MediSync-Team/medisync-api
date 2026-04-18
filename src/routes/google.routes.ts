/**
 * Google Calendar OAuth routes
 * GET  /api/google/auth-url   → returns the consent URL (profesional clicks it)
 * GET  /api/google/callback   → Google redirects here after consent
 * DELETE /api/google/disconnect → revoke & clear token
 * GET  /api/google/status     → is the profesional connected?
 */
import { Router } from 'express';
import prisma from '../lib/prisma';
import { asyncHandler, success, AppError } from '../utils/response';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';
import { getAuthUrl, exchangeCode, createOAuthClient } from '../services/google-calendar.service';

const router = Router();

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// ── GET /api/google/auth-url ─────────────────────────────────────────────────
// Returns the Google consent page URL. The JWT userId is passed as `state` so
// we know which profesional to attach the token to after the redirect.
router.get('/auth-url', authMiddleware, asyncHandler(async (req: AuthRequest, res) => {
  if (req.user!.rol !== 'PROFESIONAL') throw new AppError(403, 'FORBIDDEN', 'Solo profesionales pueden conectar Google Calendar');

  const url = getAuthUrl(req.user!.userId);
  res.json(success({ url }));
}));

// ── GET /api/google/callback ─────────────────────────────────────────────────
// Google redirects here with ?code=...&state=userId
// This is a browser redirect, so we redirect to the frontend when done.
router.get('/callback', asyncHandler(async (req, res) => {
  const { code, state: userId, error: oauthError } = req.query as Record<string, string>;

  if (oauthError || !code || !userId) {
    return res.redirect(`${FRONTEND_URL}/dashboard?google=error`);
  }

  try {
    const tokens = await exchangeCode(code);

    // Persist the full token JSON in Usuario.googleToken
    await prisma.usuario.update({
      where: { id: userId },
      data: { googleToken: JSON.stringify(tokens) },
    });

    return res.redirect(`${FRONTEND_URL}/dashboard?google=connected`);
  } catch (err) {
    console.error('[Google callback error]', err);
    return res.redirect(`${FRONTEND_URL}/dashboard?google=error`);
  }
}));

// ── DELETE /api/google/disconnect ────────────────────────────────────────────
router.delete('/disconnect', authMiddleware, asyncHandler(async (req: AuthRequest, res) => {
  const usuario = await prisma.usuario.findUnique({ where: { id: req.user!.userId } });
  if (!usuario) throw new AppError(404, 'NOT_FOUND', 'Usuario no encontrado');

  // Revoke the token with Google so the app loses access
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
