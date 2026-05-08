import { google } from 'googleapis';
import crypto from 'crypto';

// ── Google OAuth2 Client (SSO) ──

const googleSSO = new google.auth.OAuth2(
  process.env.GOOGLE_SSO_CLIENT_ID,
  process.env.GOOGLE_SSO_CLIENT_SECRET,
  `${process.env.API_URL || 'http://localhost:4000'}/api/auth/google/callback`
);

export function getGoogleAuthUrl(state: string): string {
  return googleSSO.generateAuthUrl({
    scope: ['openid', 'email', 'profile'],
    state,
    prompt: 'select_account',
    access_type: 'online',
  });
}

export async function exchangeGoogleCode(code: string) {
  const { tokens } = await googleSSO.getToken(code);

  // Decode id_token to get user info without extra HTTP call
  if (!tokens.id_token) throw new Error('No id_token in response');

  const parts = tokens.id_token.split('.');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());

  return {
    sub: payload.sub,
    email: payload.email,
    given_name: payload.given_name,
    family_name: payload.family_name,
    picture: payload.picture,
  };
}

