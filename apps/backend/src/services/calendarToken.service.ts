/**
 * Calendar Feed Token Service
 *
 * Manages persistent, rotatable tokens for calendar subscription URLs.
 * Tokens are stored in the `calendar_feed_tokens` table (migration 00069)
 * so they can be individually revoked without invalidating all feeds.
 *
 * The old stateless HMAC approach (generateFeedToken / validateFeedToken in
 * booking.controller.ts) remains available as a fallback for existing callers
 * during the migration window, but new code should use this service.
 *
 * Token format: 32 random bytes encoded as a 64-char hex string.
 * Entropy: 256 bits — guessing is infeasible.
 */

import { randomBytes } from 'crypto';
import { supabase } from '../config/supabase.js';
import type { ServiceResponse } from './index.js';

export interface CalendarFeedToken {
  id: string;
  user_id: string;
  token: string;
  revoked: boolean;
  expires_at: string | null;
  created_at: string;
  last_used_at: string | null;
}

/** Generate a cryptographically random 64-hex-char token. */
function generateToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Get the active (non-revoked, non-expired) token for a user.
 * Returns null when the user has no active token — caller should create one.
 */
export async function getActiveToken(
  userId: string,
): Promise<ServiceResponse<CalendarFeedToken | null>> {
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from('calendar_feed_tokens')
    .select('*')
    .eq('user_id', userId)
    .eq('revoked', false)
    .or(`expires_at.is.null,expires_at.gt.${now}`)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return { success: false, error: error.message };
  return { success: true, data: (data as CalendarFeedToken | null) ?? null };
}

/**
 * Get or create the active token for a user.
 * If no active token exists, a new one is minted and persisted.
 */
export async function getOrCreateToken(
  userId: string,
): Promise<ServiceResponse<CalendarFeedToken>> {
  const existing = await getActiveToken(userId);
  if (!existing.success) return { success: false, error: existing.error };

  if (existing.data) {
    return { success: true, data: existing.data };
  }

  // No active token — create one.
  const { data, error } = await supabase
    .from('calendar_feed_tokens')
    .insert({ user_id: userId, token: generateToken() })
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  return { success: true, data: data as CalendarFeedToken };
}

/**
 * Rotate the token for a user.
 *
 * Revokes all existing tokens for the user and mints a fresh one.
 * Calendar apps that cached the old URL will get 403 and must re-subscribe
 * using the new URL from GET /api/v1/bookings/calendar-feed-token.
 */
export async function rotateToken(
  userId: string,
): Promise<ServiceResponse<CalendarFeedToken>> {
  // Revoke all active tokens for this user.
  const { error: revokeError } = await supabase
    .from('calendar_feed_tokens')
    .update({ revoked: true })
    .eq('user_id', userId)
    .eq('revoked', false);

  if (revokeError) return { success: false, error: revokeError.message };

  // Mint the new token.
  const { data, error } = await supabase
    .from('calendar_feed_tokens')
    .insert({ user_id: userId, token: generateToken() })
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  return { success: true, data: data as CalendarFeedToken };
}

/**
 * Validate a raw token string against the DB.
 *
 * Returns the token row when valid, or null when the token is not found,
 * revoked, or expired. Updates `last_used_at` on a successful validation
 * so stale-token detection can flag feeds that haven't been used recently.
 *
 * Callers MUST treat a `null` result (or a failed response) as "no events":
 * revoked, expired, malformed, or unknown tokens never resolve to data.
 */
export async function validateToken(
  token: string,
): Promise<ServiceResponse<CalendarFeedToken | null>> {
  // Reject anything that is not exactly 64 lowercase hex chars. This matches
  // the format produced by generateToken() and short-circuits DB lookups for
  // obviously invalid input (including injection attempts).
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) {
    return { success: true, data: null };
  }

  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from('calendar_feed_tokens')
    .select('*')
    .eq('token', token)
    .eq('revoked', false)
    .or(`expires_at.is.null,expires_at.gt.${now}`)
    .maybeSingle();

  if (error) return { success: false, error: error.message };
  if (!data) return { success: true, data: null };

  // Update last_used_at non-blocking — a failure here must not block the feed.
  supabase
    .from('calendar_feed_tokens')
    .update({ last_used_at: now })
    .eq('id', (data as CalendarFeedToken).id)
    .then(() => {})
    .catch(() => {});

  return { success: true, data: data as CalendarFeedToken };
}

/**
 * Revoke a specific token by its raw token string.
 * Used when a user explicitly invalidates a calendar subscription.
 */
export async function revokeToken(
  token: string,
  userId: string,
): Promise<ServiceResponse<void>> {
  const { error } = await supabase
    .from('calendar_feed_tokens')
    .update({ revoked: true })
    .eq('token', token)
    .eq('user_id', userId); // scope to owner so users can't revoke others' tokens

  if (error) return { success: false, error: error.message };
  return { success: true };
}

/**
 * Resolve a raw feed token to its owning user id.
 *
 * This is the single entry point the calendar feed route should use. It
 * returns the owner id only when the token exists, is not revoked, and has
 * not expired. Any other outcome (invalid format, unknown, revoked, expired,
 * or a DB error) resolves to `null` so the route can respond 403/404 without
 * leaking events.
 */
export async function resolveFeedOwner(
  token: string,
): Promise<ServiceResponse<string | null>> {
  const result = await validateToken(token);
  if (!result.success) return { success: false, error: result.error };
  if (!result.data) return { success: true, data: null };
  return { success: true, data: result.data.user_id };
}

/**
 * Revoke every active token for a user.
 * Used when a user wants to invalidate all existing calendar subscriptions
 * at once (e.g. after a suspected leak).
 */
export async function revokeAllTokens(
  userId: string,
): Promise<ServiceResponse<void>> {
  const { error } = await supabase
    .from('calendar_feed_tokens')
    .update({ revoked: true })
    .eq('user_id', userId)
    .eq('revoked', false);

  if (error) return { success: false, error: error.message };
  return { success: true };
}
