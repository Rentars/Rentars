/**
 * Property view tracking service.
 *
 * Records a deduplicated view per viewer per property within a 1-hour window.
 * Bot user-agents are silently ignored.
 * A denormalized `view_count` on the `properties` table is incremented
 * asynchronously so property reads are never slowed.
 *
 * Deduplication strategy:
 *   window_start = floor(now, 1 hour)
 *   Unique constraint (property_id, viewer_key, window_start) prevents
 *   double-counting refreshes within the same hour.
 *
 * viewer_key:
 *   - Authenticated users  → their user id (stable, no PII exposure)
 *   - Anonymous visitors   → caller-supplied fingerprint (e.g. hashed IP+UA)
 */

import { supabase } from '@/config/supabase.js';
import type { ServiceResponse } from './index.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Duration of one dedup window in milliseconds. */
const WINDOW_MS = 60 * 60 * 1000; // 1 hour

/**
 * Known bot/crawler substrings matched against User-Agent (case-insensitive).
 * Keep this list conservative — false positives hide real views.
 */
const BOT_UA_PATTERNS = [
  'bot', 'crawler', 'spider', 'slurp', 'googlebot', 'bingbot',
  'yandex', 'baidu', 'duckduck', 'semrush', 'ahref', 'lighthouse',
  'headlesschrome', 'phantomjs', 'python-requests', 'curl/',
  'wget/', 'go-http-client',
];

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RecordViewInput {
  propertyId:  string;
  /** Authenticated user id, or undefined for anonymous. */
  userId?:     string;
  /** Pre-computed fingerprint for anonymous viewers (e.g. hash of IP+UA). */
  fingerprint?: string;
  userAgent?:  string;
  ipHash?:     string;
}

export interface ViewCountResult {
  propertyId: string;
  viewCount:  number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Truncate a Date to the start of its dedup window boundary. */
function windowStart(now: Date): string {
  const ms = now.getTime();
  return new Date(ms - (ms % WINDOW_MS)).toISOString();
}

/** Return true if the User-Agent string looks like a known bot. */
export function isBot(userAgent: string | undefined): boolean {
  if (!userAgent || !userAgent.trim()) return true;
  const ua = userAgent.toLowerCase();
  return BOT_UA_PATTERNS.some((pat) => ua.includes(pat));
}

/** Derive a stable viewer key from auth userId or anon fingerprint. */
function viewerKey(userId?: string, fingerprint?: string): string | null {
  if (userId) return `user:${userId}`;
  if (fingerprint) return `anon:${fingerprint}`;
  return null;
}

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * Record a property view, respecting bot filtering and dedup window.
 *
 * Returns `{ success: true, data: { recorded: false } }` when the view is
 * skipped (bot, missing key, or duplicate within the window).
 */
export async function recordPropertyView(
  input: RecordViewInput,
): Promise<ServiceResponse<{ recorded: boolean }>> {
  const { propertyId, userId, fingerprint, userAgent, ipHash } = input;

  if (!propertyId) return { success: false, error: 'propertyId is required' };

  // 1. Bot filter
  if (isBot(userAgent)) return { success: true, data: { recorded: false } };

  // 2. Viewer key — need at least one identifier
  const key = viewerKey(userId, fingerprint);
  if (!key) return { success: true, data: { recorded: false } };

  // 3. Dedup window
  const ws = windowStart(new Date());

  // 4. Attempt insert (unique constraint prevents double-counting)
  const { error } = await supabase.from('property_views').insert({
    property_id:  propertyId,
    viewer_key:   key,
    user_id:      userId ?? null,
    ip_hash:      ipHash ?? null,
    user_agent:   userAgent ?? null,
    window_start: ws,
  });

  if (error) {
    // 23505 = unique_violation — view already recorded this window, not an error
    if (error.code === '23505') return { success: true, data: { recorded: false } };
    return { success: false, error: error.message };
  }

  // 5. Asynchronously increment view_count (fire-and-forget, non-fatal)
  supabase.rpc('increment_property_view_count', { p_id: propertyId }).then(({ error: rpcErr }) => {
    if (rpcErr) {
      // Fallback: manual increment
      supabase
        .from('properties')
        .select('view_count')
        .eq('id', propertyId)
        .single()
        .then(({ data }) => {
          if (data) {
            const current = (data as { view_count: number }).view_count ?? 0;
            supabase
              .from('properties')
              .update({ view_count: current + 1 })
              .eq('id', propertyId)
              .then(() => {});
          }
        });
    }
  });

  return { success: true, data: { recorded: true } };
}

/**
 * Return the current `view_count` for a property.
 * Only intended for the property's owner (enforced by the controller).
 */
export async function getPropertyViewCount(
  propertyId: string,
): Promise<ServiceResponse<ViewCountResult>> {
  if (!propertyId) return { success: false, error: 'propertyId is required' };

  const { data, error } = await supabase
    .from('properties')
    .select('id, view_count')
    .eq('id', propertyId)
    .single();

  if (error || !data) return { success: false, error: 'Property not found' };

  const row = data as { id: string; view_count: number };
  return { success: true, data: { propertyId: row.id, viewCount: row.view_count ?? 0 } };
}

/**
 * Return the total view count and a daily breakdown for the last N days.
 * Used in the host dashboard.
 */
export async function getPropertyViewStats(
  propertyId: string,
  days = 30,
): Promise<ServiceResponse<{ total: number; daily: { date: string; count: number }[] }>> {
  if (!propertyId) return { success: false, error: 'propertyId is required' };

  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);

  const { data, error } = await supabase
    .from('property_views')
    .select('viewed_at')
    .eq('property_id', propertyId)
    .gte('viewed_at', since.toISOString());

  if (error) return { success: false, error: error.message };

  const rows = (data ?? []) as { viewed_at: string }[];

  // Group by calendar date (UTC)
  const byDate: Record<string, number> = {};
  for (const row of rows) {
    const date = row.viewed_at.slice(0, 10); // YYYY-MM-DD
    byDate[date] = (byDate[date] ?? 0) + 1;
  }

  const daily = Object.entries(byDate)
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return { success: true, data: { total: rows.length, daily } };
}
