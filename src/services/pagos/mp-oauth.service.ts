import { AppError } from '../../utils/response';

/**
 * MercadoPago OAuth (Marketplace) — lets a professional link their own MP account
 * so the money for their consultations settles into their account instead of the
 * platform's. Mirrors the Google Calendar OAuth service, but MercadoPago has no
 * official Node OAuth client, so we call the REST endpoints directly with `fetch`.
 *
 * Docs: https://www.mercadopago.com.ar/developers/en/docs/checkout-pro/additional-content/security/oauth
 */

const MP_AUTHORIZATION_URL = 'https://auth.mercadopago.com/authorization';
const MP_OAUTH_TOKEN_URL = 'https://api.mercadopago.com/oauth/token';

export interface MpOAuthTokenResponse {
  access_token: string;
  refresh_token: string;
  /** The seller's MercadoPago collector id — persisted as `Usuario.mpVendedorId`. */
  user_id: number | string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  public_key?: string;
  live_mode?: boolean;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new AppError(500, 'CONFIG_ERROR', `${name} no está configurado en el servidor`);
  }
  return value;
}

/**
 * Build the consent URL the professional is redirected to. `state` is a signed,
 * short-lived token (see `mercadopago.routes.ts`) binding the callback to the
 * caller so an attacker cannot attach their code to a victim's account.
 */
export function getMpAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: requireEnv('MP_CLIENT_ID'),
    response_type: 'code',
    platform_id: 'mp',
    redirect_uri: requireEnv('MP_OAUTH_REDIRECT_URI'),
    state,
  });
  return `${MP_AUTHORIZATION_URL}?${params.toString()}`;
}

async function requestOAuthToken(body: Record<string, string>): Promise<MpOAuthTokenResponse> {
  const response = await fetch(MP_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await response.json() as MpOAuthTokenResponse & {
    error?: string;
    message?: string;
    error_description?: string;
  };

  if (!response.ok || !data.access_token) {
    const errorMsg = data.error_description || data.message || data.error || `HTTP ${response.status}`;
    console.error('MP OAuth Error:', errorMsg);
    throw new AppError(400, 'MP_OAUTH_ERROR', errorMsg);
  }

  return data;
}

/** Exchange the authorization `code` from the callback for the seller's tokens. */
export async function exchangeMpCode(code: string): Promise<MpOAuthTokenResponse> {
  return requestOAuthToken({
    client_id: requireEnv('MP_CLIENT_ID'),
    client_secret: requireEnv('MP_CLIENT_SECRET'),
    grant_type: 'authorization_code',
    code,
    redirect_uri: requireEnv('MP_OAUTH_REDIRECT_URI'),
  });
}

/** Renew an expired access token using the stored refresh token. */
export async function refreshMpToken(refreshToken: string): Promise<MpOAuthTokenResponse> {
  return requestOAuthToken({
    client_id: requireEnv('MP_CLIENT_ID'),
    client_secret: requireEnv('MP_CLIENT_SECRET'),
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
}
