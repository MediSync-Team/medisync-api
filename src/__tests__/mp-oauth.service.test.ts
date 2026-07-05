import { describe, expect, it, beforeEach, jest } from '@jest/globals';
import { getMpAuthUrl, exchangeMpCode, refreshMpToken } from '../services/pagos/mp-oauth.service';

const REDIRECT = 'http://localhost:4000/api/mercadopago/oauth/callback';

describe('mp-oauth.service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getMpAuthUrl', () => {
    it('builds the consent URL with the required query params', () => {
      const url = new URL(getMpAuthUrl('signed-state'));
      expect(url.origin + url.pathname).toBe('https://auth.mercadopago.com/authorization');
      expect(url.searchParams.get('client_id')).toBe('test-mp-client-id');
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('platform_id')).toBe('mp');
      expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
      expect(url.searchParams.get('state')).toBe('signed-state');
    });
  });

  describe('exchangeMpCode', () => {
    it('posts the authorization_code grant and returns the tokens', async () => {
      const fetchMock = jest.fn(async (_url: any, _init: any) => ({
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'at', refresh_token: 'rt', user_id: 12345 }),
      }));
      (global as any).fetch = fetchMock;

      const tokens = await exchangeMpCode('the-code');

      expect(tokens).toMatchObject({ access_token: 'at', refresh_token: 'rt', user_id: 12345 });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.mercadopago.com/oauth/token',
        expect.objectContaining({ method: 'POST' }),
      );
      const body = JSON.parse((fetchMock.mock.calls[0] as any)[1].body);
      expect(body).toMatchObject({
        client_id: 'test-mp-client-id',
        client_secret: 'test-mp-client-secret',
        grant_type: 'authorization_code',
        code: 'the-code',
        redirect_uri: REDIRECT,
      });
    });

    it('throws MP_OAUTH_ERROR when MP responds with an error', async () => {
      (global as any).fetch = jest.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: 'invalid_grant', error_description: 'bad code' }),
      }));
      await expect(exchangeMpCode('bad')).rejects.toMatchObject({ code: 'MP_OAUTH_ERROR', statusCode: 400 });
    });

    it('throws when the token response has no access_token', async () => {
      (global as any).fetch = jest.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ message: 'nope' }),
      }));
      await expect(exchangeMpCode('x')).rejects.toMatchObject({ code: 'MP_OAUTH_ERROR' });
    });
  });

  describe('refreshMpToken', () => {
    it('posts the refresh_token grant', async () => {
      const fetchMock = jest.fn(async (_url: any, _init: any) => ({
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'at2', refresh_token: 'rt2', user_id: 12345 }),
      }));
      (global as any).fetch = fetchMock;

      const tokens = await refreshMpToken('old-rt');
      expect(tokens.access_token).toBe('at2');
      const body = JSON.parse((fetchMock.mock.calls[0] as any)[1].body);
      expect(body).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'old-rt' });
    });
  });
});
