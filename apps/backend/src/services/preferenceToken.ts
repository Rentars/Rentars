/**
 * Preference token service.
 *
 * Issues and verifies short-lived, signed JWT tokens that encode a user ID.
 * These tokens let recipients manage their notification preferences (or
 * unsubscribe) from an email link without needing to log in.
 *
 * Token lifetime: 30 days (configurable via PREF_TOKEN_TTL_DAYS env var).
 * Signing key   : PREF_TOKEN_SECRET env var; falls back to JWT_SECRET.
 *
 * Usage:
 *   const token = generatePreferenceToken('user-uuid');
 *   const url   = buildPreferenceUrl(token);
 *
 *   const userId = verifyPreferenceToken(token); // null if invalid/expired
 */

import jwt from 'jsonwebtoken';

function getTTLDays(): number {
  const defaultTTL = 30;
  const envValue = process.env.PREF_TOKEN_TTL_DAYS;

  if (!envValue) {
    return defaultTTL;
  }

  const parsed = Number(envValue);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultTTL;
  }

  return parsed;
}

const TTL_DAYS = getTTLDays();
const TTL_SECONDS = TTL_DAYS * 24 * 60 * 60;

function signingKey(): string {
  const key = process.env.PREF_TOKEN_SECRET ?? process.env.JWT_SECRET;
  if (!key) throw new Error('[PreferenceToken] No signing key configured (PREF_TOKEN_SECRET / JWT_SECRET)');
  return key;
}

const FRONTEND_URL = process.env.FRONTEND_URL ?? 'https://rentars.app';

// ─── Token payload ────────────────────────────────────────────────────────────

interface PrefTokenPayload {
  sub: string;  // userId
  pur: 'pref';  // purpose discriminator — guards against re-use of other JWT types
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate a signed preference management token for `userId`.
 * The token is safe to embed in email URLs.
 */
export function generatePreferenceToken(userId: string): string {
  const payload: PrefTokenPayload = { sub: userId, pur: 'pref' };
  return jwt.sign(payload, signingKey(), { expiresIn: TTL_SECONDS });
}

/**
 * Verify a preference token and return the encoded userId, or `null` if the
 * token is invalid, expired, or has the wrong purpose.
 */
export function verifyPreferenceToken(token: string): string | null {
  try {
    const decoded = jwt.verify(token, signingKey()) as PrefTokenPayload;
    if (decoded.pur !== 'pref' || !decoded.sub) return null;
    return decoded.sub;
  } catch {
    return null;
  }
}

/**
 * Build the full preference-management URL for a given token.
 * Appended `?token=<token>` so the frontend page can pick it up.
 */
export function buildPreferenceUrl(token: string): string {
  return `${FRONTEND_URL}/preferences/manage?token=${encodeURIComponent(token)}`;
}

/**
 * Convenience: generate a token for `userId` and return the full URL.
 */
export function buildPreferenceUrlForUser(userId: string): string {
  return buildPreferenceUrl(generatePreferenceToken(userId));
}
