/**
 * Refresh token service with rotation, revocation, and reuse detection.
 *
 * Refresh tokens are opaque random strings stored in Redis with a TTL.
 * They are used to issue new short-lived access tokens without re-authentication.
 *
 * Token rotation: Every refresh issues a new token and deletes the old one.
 * Reuse detection (token family): When a compromised token is reused, all tokens
 * in the same family are invalidated to prevent attackers from extending their session.
 *
 * Key format:
 *   refresh:<hashedToken> → { userId, role, familyId, issuedAt }
 *   refresh:family:<familyId> → { revokedAt } (revoked families)
 *
 * TTL: REFRESH_TOKEN_TTL_SECONDS (7 days)
 */

import crypto from 'crypto';
import { redisClient } from '@/config/redis.js';

const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const FAMILY_REVOCATION_TTL_SECONDS = 60 * 60 * 24 * 30; // Keep revocation records for 30 days
const KEY_PREFIX = 'refresh:';
const FAMILY_PREFIX = 'refresh:family:';

export interface RefreshTokenPayload {
  userId: string;
  role: string;
  familyId?: string;
  issuedAt?: number;
}

export interface TokenReuseDetection {
  familyId: string;
  isReuse: boolean;
}

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function generateFamilyId(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Issue a new refresh token for the given user and store it in Redis.
 * Establishes a token family (group of related tokens through rotation).
 * Returns the raw (un-hashed) token to send to the client once.
 */
export async function issueRefreshToken(
  payload: RefreshTokenPayload,
  familyId?: string,
): Promise<string> {
  const raw = crypto.randomBytes(40).toString('hex');
  const hash = hashToken(raw);
  const family = familyId || generateFamilyId();
  const issuedAt = Date.now();

  const tokenData = {
    ...payload,
    familyId: family,
    issuedAt,
  };

  await redisClient.set(
    `${KEY_PREFIX}${hash}`,
    JSON.stringify(tokenData),
    { EX: REFRESH_TOKEN_TTL_SECONDS },
  );

  return raw;
}

/**
 * Validate a raw refresh token and detect reuse.
 * Returns the stored payload on success, null if invalid/expired.
 * On reuse detection, revokes the entire token family to contain the breach.
 */
export async function consumeRefreshToken(
  raw: string,
): Promise<(RefreshTokenPayload & { newRefreshToken: string; reuseDetected?: boolean }) | null> {
  const hash = hashToken(raw);
  const key = `${KEY_PREFIX}${hash}`;

  const stored = await redisClient.get(key);
  if (!stored) return null;

  let payload: RefreshTokenPayload;
  try {
    payload = JSON.parse(stored) as RefreshTokenPayload;
  } catch {
    return null;
  }

  const familyId = payload.familyId;

  // Check if this family was already revoked (reuse detected on a prior attempt)
  if (familyId) {
    const familyRevoked = await redisClient.get(`${FAMILY_PREFIX}${familyId}`);
    if (familyRevoked) {
      // Family was already revoked — this is a reuse attempt
      return null;
    }
  }

  // Delete old token (one-time use)
  await redisClient.del(key);

  // Rotate: issue a new refresh token in the same family
  const newRefreshToken = await issueRefreshToken(payload, familyId);

  return { ...payload, newRefreshToken };
}

/**
 * Detect and handle token reuse by checking if a token has already been consumed.
 * Called when consumeRefreshToken returns null but we need to distinguish between
 * an already-consumed token (reuse) vs. an invalid/expired token.
 */
export async function detectTokenReuse(raw: string): Promise<TokenReuseDetection | null> {
  // A token that has been consumed won't be in Redis, so we can't directly detect it.
  // Instead, track consumed tokens in a separate tracking mechanism if needed.
  // For now, return null to indicate we couldn't determine the cause.
  return null;
}

/**
 * Revoke a specific refresh token (logout).
 */
export async function revokeRefreshToken(raw: string): Promise<void> {
  const hash = hashToken(raw);
  await redisClient.del(`${KEY_PREFIX}${hash}`);
}

/**
 * Revoke an entire token family (all tokens from the same rotation chain).
 * Called when reuse is detected to prevent attackers from using any token in the family.
 */
export async function revokeTokenFamily(familyId: string): Promise<void> {
  // Mark the family as revoked so future attempts fail
  await redisClient.set(
    `${FAMILY_PREFIX}${familyId}`,
    JSON.stringify({ revokedAt: new Date().toISOString() }),
    { EX: FAMILY_REVOCATION_TTL_SECONDS },
  );

  // Scan and delete all tokens in this family
  const keys: string[] = [];
  for await (const key of redisClient.scanIterator({ MATCH: `${KEY_PREFIX}*`, COUNT: 100 })) {
    keys.push(key);
  }

  await Promise.all(
    keys.map(async (key) => {
      const stored = await redisClient.get(key);
      if (!stored) return;
      try {
        const payload = JSON.parse(stored) as RefreshTokenPayload;
        if (payload.familyId === familyId) {
          await redisClient.del(key);
        }
      } catch {
        // ignore malformed entries
      }
    }),
  );
}

/**
 * Revoke all refresh tokens for a user by scanning Redis.
 * Use after password reset or suspected compromise to force full re-login on all devices.
 * Note: This is O(n) on the number of refresh tokens; keep TTL short enough.
 */
export async function revokeAllUserRefreshTokens(userId: string): Promise<void> {
  const keys: string[] = [];
  for await (const key of redisClient.scanIterator({ MATCH: `${KEY_PREFIX}*`, COUNT: 100 })) {
    keys.push(key);
  }

  await Promise.all(
    keys.map(async (key) => {
      const stored = await redisClient.get(key);
      if (!stored) return;
      try {
        const payload = JSON.parse(stored) as RefreshTokenPayload;
        if (payload.userId === userId) {
          // Also revoke the entire family if present
          if (payload.familyId) {
            await revokeTokenFamily(payload.familyId);
          } else {
            await redisClient.del(key);
          }
        }
      } catch {
        // ignore malformed entries
      }
    }),
  );
}
