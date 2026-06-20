import crypto from 'crypto';

/**
 * Symmetric encryption for secrets stored at rest (e.g. Google OAuth tokens).
 *
 * Uses AES-256-GCM with a key from `TOKEN_ENCRYPTION_KEY` (64 hex chars = 32 bytes).
 * Encrypted values are tagged with an `enc:v1:` prefix so {@link decryptSecret}
 * can transparently pass through legacy plaintext rows that predate encryption.
 */

const PREFIX = 'enc:v1:';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

function getKey(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('TOKEN_ENCRYPTION_KEY no configurado');
  }
  const key = Buffer.from(raw, 'hex');
  if (key.length !== 32) {
    throw new Error('TOKEN_ENCRYPTION_KEY debe ser 64 caracteres hex (32 bytes)');
  }
  return key;
}

/** True when the value was produced by {@link encryptSecret}. */
export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function encryptSecret(plain: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext.toString('hex')}`;
}

/**
 * Decrypt a value produced by {@link encryptSecret}. Legacy plaintext values
 * (no `enc:v1:` prefix) are returned unchanged so existing rows keep working
 * until they are re-saved.
 */
export function decryptSecret(value: string): string {
  if (!isEncrypted(value)) {
    return value; // legacy plaintext — pass through
  }
  const [ivHex, tagHex, dataHex] = value.slice(PREFIX.length).split(':');
  if (!ivHex || !tagHex || !dataHex) {
    throw new Error('Valor cifrado inválido');
  }
  const key = getKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}
