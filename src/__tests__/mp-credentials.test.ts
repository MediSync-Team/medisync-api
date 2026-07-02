import { describe, expect, it, beforeEach, jest } from '@jest/globals';

const mockPrisma = {
  usuario: { findUnique: jest.fn() as any, update: jest.fn() as any },
  turno: { findUnique: jest.fn() as any },
};
jest.mock('../lib/prisma', () => ({ __esModule: true, default: mockPrisma }));

// Transparent, deterministic stand-ins so the tests don't need TOKEN_ENCRYPTION_KEY.
jest.mock('../utils/crypto', () => ({
  encryptSecret: (v: string) => `enc:${v}`,
  decryptSecret: (v: string) => (v.startsWith('enc:') ? v.slice(4) : v),
  isEncrypted: (v: string) => v.startsWith('enc:'),
}));

const mockRefreshMpToken = jest.fn() as any;
jest.mock('../services/pagos/mp-oauth.service', () => ({
  refreshMpToken: (...args: any[]) => mockRefreshMpToken(...args),
}));

import {
  resolveSellerCredentials,
  resolveSellerCredentialsByTurno,
  resolveWebhookCredentials,
  callMpWithRefresh,
} from '../services/pagos/mp-credentials';
import { MpApiError } from '../services/pagos/mercadopago';

describe('mp-credentials', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.MP_ACCESS_TOKEN = 'platform-token';
  });

  describe('resolveSellerCredentials', () => {
    it('returns the professional decrypted token when linked', async () => {
      mockPrisma.usuario.findUnique.mockResolvedValue({ mpAccessToken: 'enc:seller-token', mpVendedorId: '999' });
      const creds = await resolveSellerCredentials('user-1');
      expect(creds).toEqual({ accessToken: 'seller-token', vendedorId: '999', isSeller: true, usuarioId: 'user-1' });
    });

    it('falls back to the platform token when not linked', async () => {
      mockPrisma.usuario.findUnique.mockResolvedValue({ mpAccessToken: null, mpVendedorId: null });
      const creds = await resolveSellerCredentials('user-1');
      expect(creds).toEqual({ accessToken: 'platform-token', vendedorId: null, isSeller: false, usuarioId: null });
    });
  });

  describe('resolveWebhookCredentials / byTurno', () => {
    it('resolves the seller token from the turno professional', async () => {
      mockPrisma.turno.findUnique.mockResolvedValue({
        profesional: { usuarioId: 'user-2', usuario: { mpAccessToken: 'enc:seller2', mpVendedorId: '888' } },
      });
      const creds = await resolveWebhookCredentials('turno-1');
      expect(creds).toMatchObject({ accessToken: 'seller2', isSeller: true, usuarioId: 'user-2' });
    });

    it('uses the platform token without a DB lookup when no turnoId', async () => {
      const creds = await resolveWebhookCredentials(undefined);
      expect(creds.isSeller).toBe(false);
      expect(creds.accessToken).toBe('platform-token');
      expect(mockPrisma.turno.findUnique).not.toHaveBeenCalled();
    });

    it('falls back to the platform token when the turno/professional is missing', async () => {
      mockPrisma.turno.findUnique.mockResolvedValue(null);
      const creds = await resolveSellerCredentialsByTurno('missing');
      expect(creds.isSeller).toBe(false);
      expect(creds.accessToken).toBe('platform-token');
    });
  });

  describe('callMpWithRefresh', () => {
    it('returns the result without refreshing on success', async () => {
      const fn = jest.fn(async () => 'ok');
      const result = await callMpWithRefresh(
        { accessToken: 'seller-token', vendedorId: '1', isSeller: true, usuarioId: 'user-1' },
        fn,
      );
      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(1);
      expect(mockRefreshMpToken).not.toHaveBeenCalled();
    });

    it('refreshes a seller token on 401 and retries once', async () => {
      mockPrisma.usuario.findUnique.mockResolvedValue({ mpRefreshToken: 'enc:old-rt' });
      mockRefreshMpToken.mockResolvedValue({ access_token: 'fresh', refresh_token: 'new-rt', user_id: '999' });
      const fn = jest.fn()
        .mockImplementationOnce(async () => { throw new MpApiError(401, 'unauthorized'); })
        .mockImplementationOnce(async (token: any) => `ok:${token}`) as any;

      const result = await callMpWithRefresh(
        { accessToken: 'stale', vendedorId: '1', isSeller: true, usuarioId: 'user-1' },
        fn,
      );

      expect(result).toBe('ok:fresh');
      expect(mockRefreshMpToken).toHaveBeenCalledWith('old-rt');
      expect(mockPrisma.usuario.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'user-1' },
        data: expect.objectContaining({ mpAccessToken: 'enc:fresh' }),
      }));
    });

    it('does not refresh a platform token on 401', async () => {
      const fn = jest.fn(async () => { throw new MpApiError(401, 'unauthorized'); }) as any;
      await expect(callMpWithRefresh(
        { accessToken: 'platform-token', vendedorId: null, isSeller: false, usuarioId: null },
        fn,
      )).rejects.toBeInstanceOf(MpApiError);
      expect(mockRefreshMpToken).not.toHaveBeenCalled();
    });

    it('rethrows the original error when the token refresh fails', async () => {
      mockPrisma.usuario.findUnique.mockResolvedValue({ mpRefreshToken: 'enc:old-rt' });
      mockRefreshMpToken.mockRejectedValue(new Error('refresh boom'));
      const fn = jest.fn(async () => { throw new MpApiError(401, 'unauthorized'); }) as any;

      await expect(callMpWithRefresh(
        { accessToken: 'stale', vendedorId: '1', isSeller: true, usuarioId: 'user-1' },
        fn,
      )).rejects.toMatchObject({ status: 401 });
    });
  });
});
