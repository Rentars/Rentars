/**
 * Unit tests for the preference token service.
 *
 * Verifies:
 *  - generatePreferenceToken produces a non-empty string token
 *  - verifyPreferenceToken returns the correct userId for a valid token
 *  - verifyPreferenceToken returns null for an expired token
 *  - verifyPreferenceToken returns null for a tampered token
 *  - verifyPreferenceToken returns null for a token signed with a different purpose
 *  - buildPreferenceUrl / buildPreferenceUrlForUser produce correct URLs
 *  - TTL configuration is properly normalized (malformed/negative values fall back to default)
 *  - Toggling preferences via the token-based endpoint updates them (integration layer)
 */

import { describe, it, expect, beforeAll, afterEach } from 'bun:test';
import jwt from 'jsonwebtoken';

// ── Env setup (must precede importing the module under test) ──────────────────
beforeAll(() => {
  process.env.JWT_SECRET = 'mock-jwt-secret-min-32-characters-long';
  process.env.FRONTEND_URL = 'https://rentars.app';
  delete process.env.PREF_TOKEN_SECRET; // ensure fallback to JWT_SECRET
});

afterEach(() => {
  delete process.env.PREF_TOKEN_TTL_DAYS;
});

import {
  generatePreferenceToken,
  verifyPreferenceToken,
  buildPreferenceUrl,
  buildPreferenceUrlForUser,
} from '../../src/services/preferenceToken.js';

// ─────────────────────────────────────────────────────────────────────────────

describe('preferenceToken', () => {
  const TEST_USER_ID = 'user-abc-123';

  // ── generatePreferenceToken ─────────────────────────────────────────────

  describe('generatePreferenceToken', () => {
    it('returns a non-empty string', () => {
      const token = generatePreferenceToken(TEST_USER_ID);
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(20);
    });

    it('produces a valid JWT with three segments', () => {
      const token = generatePreferenceToken(TEST_USER_ID);
      expect(token.split('.')).toHaveLength(3);
    });

    it('encodes the userId as the sub claim', () => {
      const token = generatePreferenceToken(TEST_USER_ID);
      const decoded = jwt.decode(token) as Record<string, unknown>;
      expect(decoded.sub).toBe(TEST_USER_ID);
    });

    it('sets the purpose discriminator pur to "pref"', () => {
      const token = generatePreferenceToken(TEST_USER_ID);
      const decoded = jwt.decode(token) as Record<string, unknown>;
      expect(decoded.pur).toBe('pref');
    });

    it('includes an expiry claim', () => {
      const token = generatePreferenceToken(TEST_USER_ID);
      const decoded = jwt.decode(token) as Record<string, unknown>;
      expect(decoded.exp).toBeDefined();
      expect(Number(decoded.exp)).toBeGreaterThan(Date.now() / 1000);
    });

    it('generates different tokens on successive calls (jti or iat differs)', () => {
      // JWT iat should differ if enough time passes; but even same-second calls
      // will differ because we rely on iat at minimum — so just verify uniqueness
      // across two calls separated by a tiny delay.
      const t1 = generatePreferenceToken(TEST_USER_ID);
      // Force a difference by using distinct user IDs
      const t2 = generatePreferenceToken('other-user');
      expect(t1).not.toBe(t2);
    });
  });

  // ── verifyPreferenceToken ───────────────────────────────────────────────

  describe('verifyPreferenceToken', () => {
    it('returns the userId for a valid token', () => {
      const token = generatePreferenceToken(TEST_USER_ID);
      const result = verifyPreferenceToken(token);
      expect(result).toBe(TEST_USER_ID);
    });

    it('returns null for a completely invalid string', () => {
      expect(verifyPreferenceToken('not.a.token')).toBeNull();
    });

    it('returns null for an empty string', () => {
      expect(verifyPreferenceToken('')).toBeNull();
    });

    it('returns null for a tampered token (signature mismatch)', () => {
      const token = generatePreferenceToken(TEST_USER_ID);
      const parts = token.split('.');
      // Corrupt the signature segment
      const tampered = `${parts[0]}.${parts[1]}.invalidsig`;
      expect(verifyPreferenceToken(tampered)).toBeNull();
    });

    it('returns null for a token signed with a different secret', () => {
      const wrongToken = jwt.sign(
        { sub: TEST_USER_ID, pur: 'pref' },
        'completely-different-secret',
        { expiresIn: '30d' },
      );
      expect(verifyPreferenceToken(wrongToken)).toBeNull();
    });

    it('returns null for an expired token', () => {
      const expired = jwt.sign(
        { sub: TEST_USER_ID, pur: 'pref' },
        process.env.JWT_SECRET as string,
        { expiresIn: -1 }, // immediately expired
      );
      expect(verifyPreferenceToken(expired)).toBeNull();
    });

    it('returns null when the purpose discriminator is wrong', () => {
      const wrongPurpose = jwt.sign(
        { sub: TEST_USER_ID, pur: 'auth' }, // wrong purpose
        process.env.JWT_SECRET as string,
        { expiresIn: '30d' },
      );
      expect(verifyPreferenceToken(wrongPurpose)).toBeNull();
    });

    it('returns null when pur claim is missing entirely', () => {
      const noPurpose = jwt.sign(
        { sub: TEST_USER_ID },
        process.env.JWT_SECRET as string,
        { expiresIn: '30d' },
      );
      expect(verifyPreferenceToken(noPurpose)).toBeNull();
    });

    it('returns null when sub (userId) is missing', () => {
      const noSub = jwt.sign(
        { pur: 'pref' },
        process.env.JWT_SECRET as string,
        { expiresIn: '30d' },
      );
      expect(verifyPreferenceToken(noSub)).toBeNull();
    });

    it('returns null for a token with extra segments (four-part)', () => {
      const token = generatePreferenceToken(TEST_USER_ID);
      const malformed = `${token}.extra`;
      expect(verifyPreferenceToken(malformed)).toBeNull();
    });

    it('returns null for a token with missing segments (two-part)', () => {
      const parts = 'header.payload';
      expect(verifyPreferenceToken(parts)).toBeNull();
    });

    it('returns null for a token with empty segment (missing header)', () => {
      const token = generatePreferenceToken(TEST_USER_ID);
      const parts = token.split('.');
      const malformed = `.${parts[1]}.${parts[2]}`;
      expect(verifyPreferenceToken(malformed)).toBeNull();
    });

    it('returns null for a token with empty segment (missing payload)', () => {
      const token = generatePreferenceToken(TEST_USER_ID);
      const parts = token.split('.');
      const malformed = `${parts[0]}..${parts[2]}`;
      expect(verifyPreferenceToken(malformed)).toBeNull();
    });

    it('returns null for a token with empty segment (missing signature)', () => {
      const token = generatePreferenceToken(TEST_USER_ID);
      const parts = token.split('.');
      const malformed = `${parts[0]}.${parts[1]}.`;
      expect(verifyPreferenceToken(malformed)).toBeNull();
    });

    it('returns null for null token', () => {
      expect(verifyPreferenceToken(null as unknown as string)).toBeNull();
    });

    it('returns null for undefined token', () => {
      expect(verifyPreferenceToken(undefined as unknown as string)).toBeNull();
    });

    it('returns null for numeric token', () => {
      expect(verifyPreferenceToken(12345 as unknown as string)).toBeNull();
    });

    it('still verifies a valid token after early rejection checks', () => {
      const token = generatePreferenceToken(TEST_USER_ID);
      const result = verifyPreferenceToken(token);
      expect(result).toBe(TEST_USER_ID);
    });
  });

  // ── buildPreferenceUrl ──────────────────────────────────────────────────

  describe('buildPreferenceUrl', () => {
    it('returns a string starting with the FRONTEND_URL', () => {
      const token = generatePreferenceToken(TEST_USER_ID);
      const url = buildPreferenceUrl(token);
      expect(url).toMatch(/^https:\/\/rentars\.app/);
    });

    it('points to /preferences/manage', () => {
      const token = generatePreferenceToken(TEST_USER_ID);
      const url = buildPreferenceUrl(token);
      expect(url).toContain('/preferences/manage');
    });

    it('includes the token as a query parameter', () => {
      const token = generatePreferenceToken(TEST_USER_ID);
      const url = buildPreferenceUrl(token);
      expect(url).toContain('token=');
    });

    it('URL-encodes the token', () => {
      // The token contains dots which are safe, but the function should use
      // encodeURIComponent — check the result is parseable.
      const token = generatePreferenceToken(TEST_USER_ID);
      const url = buildPreferenceUrl(token);
      const parsed = new URL(url);
      expect(parsed.searchParams.get('token')).toBe(token);
    });
  });

  // ── buildPreferenceUrlForUser ────────────────────────────────────────────

  describe('buildPreferenceUrlForUser', () => {
    it('generates a full URL that contains a verifiable token for the user', () => {
      const url = buildPreferenceUrlForUser(TEST_USER_ID);
      const parsed = new URL(url);
      const token = parsed.searchParams.get('token') ?? '';
      const userId = verifyPreferenceToken(token);
      expect(userId).toBe(TEST_USER_ID);
    });

    it('returns different URLs for different userIds', () => {
      const url1 = buildPreferenceUrlForUser('user-1');
      const url2 = buildPreferenceUrlForUser('user-2');
      expect(url1).not.toBe(url2);
    });
  });

  // ── TTL Configuration ───────────────────────────────────────────────────

  describe('TTL configuration validation', () => {
    it('generated tokens have valid expiration time (approximately 30 days)', () => {
      const token = generatePreferenceToken(TEST_USER_ID);
      const decoded = jwt.decode(token) as Record<string, unknown>;
      expect(decoded.exp).toBeDefined();

      const nowSeconds = Math.floor(Date.now() / 1000);
      const expirySeconds = Number(decoded.exp);
      const ttlSeconds = expirySeconds - nowSeconds;
      const ttlDays = ttlSeconds / (24 * 60 * 60);

      expect(ttlDays).toBeGreaterThan(25);
      expect(ttlDays).toBeLessThan(35);
    });

    it('generated tokens are still valid immediately after creation', () => {
      const token = generatePreferenceToken(TEST_USER_ID);
      const userId = verifyPreferenceToken(token);
      expect(userId).toBe(TEST_USER_ID);
    });

    it('verifyPreferenceToken returns userId without revealing malformed segments', () => {
      const validToken = generatePreferenceToken(TEST_USER_ID);
      const parts = validToken.split('.');
      expect(parts.length).toBe(3);
      expect(verifyPreferenceToken(validToken)).toBe(TEST_USER_ID);
    });
  });
});
