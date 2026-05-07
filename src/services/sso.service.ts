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

// ── Microsoft OAuth2 Client (standard OIDC) ──

const MICROSOFT_TENANT = process.env.MICROSOFT_TENANT_ID || 'common';
const MICROSOFT_SCOPES = 'openid email profile';
const MICROSOFT_REDIRECT_URI = `${process.env.API_URL || 'http://localhost:4000'}/api/auth/microsoft/callback`;

export function getMicrosoftAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.MICROSOFT_CLIENT_ID || '',
    scope: MICROSOFT_SCOPES,
    response_type: 'code',
    redirect_uri: MICROSOFT_REDIRECT_URI,
    state,
    prompt: 'select_account',
  });

  return `https://login.microsoftonline.com/${MICROSOFT_TENANT}/oauth2/v2.0/authorize?${params.toString()}`;
}

export async function exchangeMicrosoftCode(code: string) {
  const params = new URLSearchParams({
    client_id: process.env.MICROSOFT_CLIENT_ID || '',
    client_secret: process.env.MICROSOFT_CLIENT_SECRET || '',
    code,
    grant_type: 'authorization_code',
    redirect_uri: MICROSOFT_REDIRECT_URI,
  });

  const response = await fetch(
    `https://login.microsoftonline.com/${MICROSOFT_TENANT}/oauth2/v2.0/token`,
    {
      method: 'POST',
      body: params.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }
  );

  if (!response.ok) {
    throw new Error(`Microsoft token error: ${response.statusText}`);
  }

  const data = (await response.json()) as any;
  if (!data.id_token) throw new Error('No id_token in Microsoft response');

  // Decode id_token
  const parts = data.id_token.split('.');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());

  return {
    sub: payload.sub,
    email: payload.email,
    given_name: payload.given_name,
    family_name: payload.family_name,
  };
}
