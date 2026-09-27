/**
 * Unit tests for push subscription key encryption (issue 074).
 *
 * A stored `auth` secret is enough to push arbitrary content to a device, so
 * these tests pin down the at-rest guarantees: round-trip fidelity, a fresh IV
 * per write, tamper detection, and the plaintext passthrough that keeps rows
 * written before the secret was configured readable.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  PUSH_KEY_ENVELOPE_PREFIX,
  decryptPushKey,
  encryptPushKey,
  isEncryptedPushKey,
  isPushKeyEncryptionEnabled,
  toPublicSubscription,
} from '../../src/services/push-crypto.js';

const SECRET = 'test-encryption-secret';

describe('push-crypto', () => {
  beforeEach(() => {
    delete process.env.PUSH_KEY_ENCRYPTION_SECRET;
  });

  afterEach(() => {
    delete process.env.PUSH_KEY_ENCRYPTION_SECRET;
  });

  describe('when PUSH_KEY_ENCRYPTION_SECRET is not configured', () => {
    it('reports encryption as disabled', () => {
      expect(isPushKeyEncryptionEnabled()).toBe(false);
    });

    it('stores the key unchanged so the service keeps working', () => {
      expect(encryptPushKey('plain-key')).toBe('plain-key');
      expect(decryptPushKey('plain-key')).toBe('plain-key');
    });
  });

  describe('when PUSH_KEY_ENCRYPTION_SECRET is configured', () => {
    beforeEach(() => {
      process.env.PUSH_KEY_ENCRYPTION_SECRET = SECRET;
    });

    it('reports encryption as enabled', () => {
      expect(isPushKeyEncryptionEnabled()).toBe(true);
    });

    it('round-trips a key', () => {
      const ciphertext = encryptPushKey('BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM');

      expect(ciphertext).not.toContain('BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA');
      expect(isEncryptedPushKey(ciphertext)).toBe(true);
      expect(decryptPushKey(ciphertext)).toBe(
        'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM'
      );
    });

    it('produces a fresh ciphertext for the same key (random IV)', () => {
      const first = encryptPushKey('same-key');
      const second = encryptPushKey('same-key');

      expect(first).not.toBe(second);
      expect(decryptPushKey(first)).toBe('same-key');
      expect(decryptPushKey(second)).toBe('same-key');
    });

    it('detects tampering with the ciphertext', () => {
      const ciphertext = encryptPushKey('tamper-me');
      const parts = ciphertext.split(':');
      const flipped = Buffer.from(parts[3], 'base64url');
      flipped[0] = flipped[0] ^ 0xff;
      parts[3] = flipped.toString('base64url');

      expect(() => decryptPushKey(parts.join(':'))).toThrow();
    });

    it('detects a swapped authentication tag', () => {
      const first = encryptPushKey('first');
      const second = encryptPushKey('second');
      const [, iv, , body] = second.split(':');
      const [, , tag] = first.split(':');

      expect(() => decryptPushKey(`${PUSH_KEY_ENVELOPE_PREFIX}${iv}:${tag}:${body}`)).toThrow();
    });

    it('rejects a malformed envelope', () => {
      expect(() => decryptPushKey(`${PUSH_KEY_ENVELOPE_PREFIX}not-an-envelope`)).toThrow(
        'Malformed push key envelope'
      );
    });

    it('still reads plaintext rows written before encryption was enabled', () => {
      expect(decryptPushKey('legacy-plaintext-key')).toBe('legacy-plaintext-key');
    });
  });

  describe('toPublicSubscription', () => {
    it('drops the subscription secrets from API responses', () => {
      process.env.PUSH_KEY_ENCRYPTION_SECRET = SECRET;

      const projected = toPublicSubscription({
        id: 'sub-1',
        user_id: 'u1',
        endpoint: 'https://push.example.com/1',
        p256dh: encryptPushKey('public-key'),
        auth: encryptPushKey('private-secret'),
        permission: 'granted',
        last_seen_at: '2026-09-27T00:00:00.000Z',
      });

      expect(projected).not.toBeNull();
      expect(projected?.endpoint).toBe('https://push.example.com/1');
      expect(projected?.keys_encrypted).toBe(true);
      expect(projected).not.toHaveProperty('p256dh');
      expect(projected).not.toHaveProperty('auth');
      expect(JSON.stringify(projected)).not.toContain('private-secret');
    });

    it('flags plaintext rows as unencrypted and returns null for null', () => {
      const projected = toPublicSubscription({ endpoint: 'https://push.example.com/1', p256dh: 'plain' });
      expect(projected?.keys_encrypted).toBe(false);
      expect(toPublicSubscription(null)).toBeNull();
    });
  });
});
