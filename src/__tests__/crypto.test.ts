import { beforeAll, describe, expect, it } from '@jest/globals';
import crypto from 'crypto';

describe('utils/crypto secret encryption (C-A2)', () => {
  beforeAll(() => {
    process.env.TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
  });

  // Imported after the key is set so getKey() succeeds.
  function load() {
    return require('../utils/crypto') as typeof import('../utils/crypto');
  }

  it('round-trips a secret', () => {
    const { encryptSecret, decryptSecret, isEncrypted } = load();
    const plain = JSON.stringify({ access_token: 'abc', refresh_token: 'xyz' });
    const blob = encryptSecret(plain);

    expect(isEncrypted(blob)).toBe(true);
    expect(blob).not.toContain('abc');
    expect(decryptSecret(blob)).toBe(plain);
  });

  it('passes through legacy plaintext unchanged', () => {
    const { decryptSecret, isEncrypted } = load();
    const legacy = '{"access_token":"legacy"}';

    expect(isEncrypted(legacy)).toBe(false);
    expect(decryptSecret(legacy)).toBe(legacy);
  });

  it('produces a different ciphertext each time (random IV)', () => {
    const { encryptSecret } = load();
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'));
  });

  it('fails to decrypt a tampered ciphertext (GCM auth)', () => {
    const { encryptSecret, decryptSecret } = load();
    const blob = encryptSecret('secret');
    const tampered = blob.slice(0, -2) + (blob.endsWith('00') ? '11' : '00');
    expect(() => decryptSecret(tampered)).toThrow();
  });
});
