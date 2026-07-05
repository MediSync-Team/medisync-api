/**
 * MercadoPago OAuth (Marketplace) routes — a professional links their own MP
 * account so consultation payments settle into their account (see
 * `services/pagos/mp-credentials.ts` for how the linked token is then used).
 *
 * GET    /api/mercadopago/oauth/auth-url   → returns the consent URL
 * GET    /api/mercadopago/oauth/callback   → MP redirects here after consent
 * DELETE /api/mercadopago/oauth/disconnect → revoke locally (clear tokens)
 * GET    /api/mercadopago/oauth/status     → is the professional connected?
 *
 * Mirrors `google.routes.ts`. Only PROFESIONAL accounts can link (patients pay
 * through Checkout Pro without linking anything).
 */
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../lib/prisma';
import { asyncHandler, success } from '../utils/response';
import { authMiddleware, AuthRequest } from '../middleware/auth.middleware';
import { getMpAuthUrl, exchangeMpCode } from '../services/pagos/mp-oauth.service';
import { encryptSecret } from '../utils/crypto';

const router = Router();

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

type MpOAuthStatePayload = { userId: string };

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET no configurado');
  return secret;
}

// The OAuth `state` is a short-lived JWT signed with JWT_SECRET. Because /auth-url
// is authenticated, the state can only ever carry the caller's own userId — an
// attacker cannot forge a state binding their MP code to a victim's account.
function signOAuthState(payload: MpOAuthStatePayload): string {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: '10m' });
}

function verifyOAuthState(state: string): MpOAuthStatePayload | null {
  try {
    const decoded = jwt.verify(state, getJwtSecret()) as Partial<MpOAuthStatePayload>;
    if (!decoded.userId) return null;
    return { userId: decoded.userId };
  } catch {
    return null;
  }
}

// ── GET /api/mercadopago/oauth/auth-url ──────────────────────────────────────
router.get('/oauth/auth-url', authMiddleware('PROFESIONAL'), asyncHandler(async (req: AuthRequest, res) => {
  const state = signOAuthState({ userId: req.user!.userId });
  const url = getMpAuthUrl(state);
  res.json(success({ url }));
}));

// ── GET /api/mercadopago/oauth/callback ──────────────────────────────────────
// MP redirects here with ?code=...&state=<signed jwt>
router.get('/oauth/callback', asyncHandler(async (req, res) => {
  const { code, state, error: oauthError } = req.query as Record<string, string>;
  const dashboardUrl = `${FRONTEND_URL}/dashboard`;

  if (oauthError || !code || !state) {
    return res.redirect(`${dashboardUrl}?mp=error`);
  }

  // State must be a valid, unexpired, server-signed token. Reject forged states.
  const verified = verifyOAuthState(state);
  if (!verified) {
    return res.redirect(`${dashboardUrl}?mp=error`);
  }

  try {
    const tokens = await exchangeMpCode(code);

    await prisma.usuario.update({
      where: { id: verified.userId },
      data: {
        mpAccessToken: encryptSecret(tokens.access_token),
        mpRefreshToken: tokens.refresh_token ? encryptSecret(tokens.refresh_token) : null,
        mpVendedorId: String(tokens.user_id),
      },
    });

    return res.redirect(`${dashboardUrl}?mp=connected`);
  } catch (err) {
    console.error('[MercadoPago callback error]', err);
    return res.redirect(`${dashboardUrl}?mp=error`);
  }
}));

// ── DELETE /api/mercadopago/oauth/disconnect ─────────────────────────────────
router.delete('/oauth/disconnect', authMiddleware('PROFESIONAL'), asyncHandler(async (req: AuthRequest, res) => {
  await prisma.usuario.update({
    where: { id: req.user!.userId },
    data: { mpAccessToken: null, mpRefreshToken: null, mpVendedorId: null },
  });

  res.json(success({ disconnected: true }));
}));

// ── GET /api/mercadopago/oauth/status ────────────────────────────────────────
router.get('/oauth/status', authMiddleware('PROFESIONAL'), asyncHandler(async (req: AuthRequest, res) => {
  const usuario = await prisma.usuario.findUnique({
    where: { id: req.user!.userId },
    select: { mpVendedorId: true },
  });

  res.json(success({
    connected: Boolean(usuario?.mpVendedorId),
    vendedorId: usuario?.mpVendedorId ?? null,
  }));
}));

export { router as mercadopagoRouter };
