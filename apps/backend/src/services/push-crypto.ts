/**
 * Encryption-at-rest helpers for stored web-push subscription keys.
 *
 * A browser push subscription carries two secrets — `p256dh` (the client's
 * public key) and `auth` (the client's auth secret). Without `auth` nobody can
 * forge a message the browser will accept, so a leaked database row is enough
 * for an attacker to push arbitrary content to a user's device. Both values are
 * therefore encrypted before they are written and decrypted only when a push is
 * about to be delivered.
 *
 * Format: `v1:<iv>:<authTag>:<ciphertext>`, each part base64url encoded, using
 * AES-256-GCM with a random 96-bit IV per record. The GCM tag makes tampering
 * with a stored row detectable. The key is derived from
 * `PUSH_KEY_ENCRYPTION_SECRET` so the raw secret is never used directly and can
 * be rotated without changing its length requirements.
 *
 * When `PUSH_KEY_ENCRYPTION_SECRET` is not configured, values are stored as-is
 * (development / self-hosted setups that have not provisioned the secret). This
 * is deliberate: `decryptPushKey` passes plaintext through, so enabling the
 * secret later encrypts new writes while old rows keep working.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export const PUSH_KEY_ENVELOPE_PREFIX = 'v1:';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

export function pushKeyEncryptionSecret(): string | undefined {
  const secret = process.env.PUSH_KEY_ENCRYPTION_SECRET?.trim();
  return secret ? secret : undefined;
}

export function isPushKeyEncryptionEnabled(): boolean {
  return pushKeyEncryptionSecret() !== undefined;
}

function encryptionKey(): Buffer {
  const secret = pushKeyEncryptionSecret();
  if (!secret) {
    throw new Error('PUSH_KEY_ENCRYPTION_SECRET is not configured');
  }
  // Fixed-length key from an arbitrary-length secret.
  return createHash('sha256').update(secret, 'utf8').digest();
}

export function isEncryptedPushKey(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(PUSH_KEY_ENVELOPE_PREFIX);
}

/**
 * Encrypts a subscription key. Returns the input unchanged when encryption is
 * not configured so the service keeps working without the secret.
 */
export function encryptPushKey(plaintext: string): string {
  if (!isPushKeyEncryptionEnabled()) return plaintext;

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    `${PUSH_KEY_ENVELOPE_PREFIX}${iv.toString('base64url')}`,
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

/**
 * Decrypts a stored subscription key. Plaintext values (rows written before
 * encryption was enabled) are returned unchanged, and malformed envelopes throw
 * so a corrupted row surfaces in logs instead of silently breaking delivery.
 */
export function decryptPushKey(value: string): string {
  if (!isEncryptedPushKey(value)) return value;

  const [version, ivPart, tagPart, ciphertextPart] = value.split(':');
  if (version !== 'v1' || !ivPart || !tagPart || !ciphertextPart) {
    throw new Error('Malformed push key envelope');
  }

  const decipher = createDecipheriv(
    ALGORITHM,
    encryptionKey(),
    Buffer.from(ivPart, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export interface StoredSubscriptionRow {
  id?: string;
  user_id?: string;
  endpoint?: string;
  p256dh?: string;
  auth?: string;
  user_agent?: string | null;
  permission?: string | null;
  expiration_time?: string | null;
  last_seen_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  [key: string]: unknown;
}

export interface PublicPushSubscription {
  id?: string;
  user_id?: string;
  endpoint?: string;
  user_agent?: string | null;
  permission?: string | null;
  expiration_time?: string | null;
  last_seen_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  keys_encrypted: boolean;
}

/**
 * Projects a stored row onto the fields that are safe to return over the API.
 * The subscription secrets are dropped: clients already hold them locally, and
 * echoing them back would turn any read endpoint into a secret disclosure.
 */
export function toPublicSubscription(row: StoredSubscriptionRow | null): PublicPushSubscription | null {
  if (!row) return null;

  return {
    id: row.id,
    user_id: row.user_id,
    endpoint: row.endpoint,
    user_agent: row.user_agent ?? null,
    permission: row.permission ?? null,
    expiration_time: row.expiration_time ?? null,
    last_seen_at: row.last_seen_at ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
    keys_encrypted: isEncryptedPushKey(row.p256dh),
  };
}
