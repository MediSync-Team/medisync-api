import prisma from '../../lib/prisma';
import { decryptSecret, encryptSecret } from '../../utils/crypto';
import { MpApiError } from './mercadopago';
import { refreshMpToken } from './mp-oauth.service';

/**
 * Which MercadoPago account a payment should be routed through. When a
 * professional has linked their account (`isSeller: true`) we use their token so
 * the money settles into their account; otherwise we fall back to the platform
 * token so payments keep working (the current, pre-linking behavior).
 */
export interface SellerCredentials {
  accessToken: string;
  /** The seller's MP collector id, or null on platform fallback. */
  vendedorId: string | null;
  isSeller: boolean;
  /** usuarioId of the linked professional (for lazy refresh); null on fallback. */
  usuarioId: string | null;
}

function platformCredentials(): SellerCredentials {
  return {
    accessToken: process.env.MP_ACCESS_TOKEN || '',
    vendedorId: null,
    isSeller: false,
    usuarioId: null,
  };
}

function buildCredentials(
  usuarioId: string,
  usuario: { mpAccessToken: string | null; mpVendedorId: string | null } | null | undefined,
): SellerCredentials {
  if (usuario?.mpAccessToken) {
    return {
      accessToken: decryptSecret(usuario.mpAccessToken),
      vendedorId: usuario.mpVendedorId ?? null,
      isSeller: true,
      usuarioId,
    };
  }
  return platformCredentials();
}

/** Resolve the receiving credentials for a professional by their usuarioId. */
export async function resolveSellerCredentials(usuarioId: string): Promise<SellerCredentials> {
  const usuario = await prisma.usuario.findUnique({
    where: { id: usuarioId },
    select: { mpAccessToken: true, mpVendedorId: true },
  });
  return buildCredentials(usuarioId, usuario);
}

/**
 * Resolve the receiving credentials for the professional who owns a turno. Used
 * by the webhook, which knows the turnoId (carried in the notification_url) but
 * not the usuarioId. Falls back to the platform token when the turno/professional
 * cannot be resolved or has not linked an account.
 */
export async function resolveSellerCredentialsByTurno(turnoId: string): Promise<SellerCredentials> {
  const turno = await prisma.turno.findUnique({
    where: { id: turnoId },
    select: {
      profesional: {
        select: {
          usuarioId: true,
          usuario: { select: { mpAccessToken: true, mpVendedorId: true } },
        },
      },
    },
  });

  const profesional = turno?.profesional;
  if (!profesional) return platformCredentials();
  return buildCredentials(profesional.usuarioId, profesional.usuario);
}

/**
 * Credentials for a webhook fetch: the seller's (resolved by turnoId, carried on
 * the notification_url) when known, or the platform token otherwise. Passing no
 * turnoId skips the DB lookup entirely (platform fallback), preserving the
 * pre-linking behavior for payments created without a seller.
 */
export async function resolveWebhookCredentials(turnoId: string | undefined): Promise<SellerCredentials> {
  if (turnoId) return resolveSellerCredentialsByTurno(turnoId);
  return platformCredentials();
}

/**
 * Renew a linked professional's access token using their stored refresh token,
 * persisting the rotated tokens encrypted. Returns the fresh access token, or
 * null if there is no refresh token or the refresh failed.
 */
async function refreshAndPersistSellerToken(usuarioId: string): Promise<string | null> {
  const usuario = await prisma.usuario.findUnique({
    where: { id: usuarioId },
    select: { mpRefreshToken: true },
  });
  if (!usuario?.mpRefreshToken) return null;

  try {
    const tokens = await refreshMpToken(decryptSecret(usuario.mpRefreshToken));
    await prisma.usuario.update({
      where: { id: usuarioId },
      data: {
        mpAccessToken: encryptSecret(tokens.access_token),
        // MP rotates the refresh token; keep the previous one if none returned.
        ...(tokens.refresh_token ? { mpRefreshToken: encryptSecret(tokens.refresh_token) } : {}),
        mpVendedorId: String(tokens.user_id),
      },
    });
    return tokens.access_token;
  } catch (err) {
    console.error('[MercadoPago] Falló el refresh del token del vendedor', { usuarioId, err });
    return null;
  }
}

/**
 * Run an authenticated MercadoPago call, retrying once with a refreshed token if
 * a linked seller's access token has expired (Mp responds 401). No-op refresh for
 * the platform-token fallback.
 */
export async function callMpWithRefresh<T>(
  creds: SellerCredentials,
  fn: (accessToken: string) => Promise<T>,
): Promise<T> {
  try {
    return await fn(creds.accessToken);
  } catch (err) {
    if (creds.isSeller && creds.usuarioId && err instanceof MpApiError && err.status === 401) {
      const fresh = await refreshAndPersistSellerToken(creds.usuarioId);
      if (fresh) {
        return await fn(fresh);
      }
    }
    throw err;
  }
}
