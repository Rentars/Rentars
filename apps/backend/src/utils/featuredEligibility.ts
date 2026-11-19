/**
 * Centralized featured-listing eligibility policy (Feature 2).
 *
 * Every public path that decides whether a listing is "currently featured" —
 * the featured endpoint, search promotion, advanced-search badge, and any
 * cache that materializes featured rows — MUST route through
 * {@link isFeaturedEligible}.  Keeping the predicate in one place guarantees
 * that expired, soft-deleted, draft, or moderation-hidden listings can never
 * be presented as featured, and that the badge never implies a ranking
 * guarantee the backend does not enforce.
 *
 * Time policy: "now" is resolved server-side and passed in explicitly so the
 * predicate is deterministic and unit-testable across timezone boundaries.
 * `featured_until` is TIMESTAMPTZ, so the comparison is on absolute instants
 * and is independent of the server's session timezone.
 */

/** Minimal row shape needed to evaluate featured eligibility. */
export interface FeaturedEligibleRow {
  /** Promotion window end (TIMESTAMPTZ ISO string). NULL ⇒ not featured. */
  featured_until?: string | null;
  /** Listing lifecycle status; only 'available' is promotable. */
  status?: string;
  /** Soft-delete tombstone; non-null ⇒ never featured. */
  deleted_at?: string | null;
  /** Draft workflow state; 'draft' ⇒ never featured. */
  draft_status?: string;
  /** Moderation visibility; 'hidden' ⇒ never featured. */
  moderation_state?: string;
}

/**
 * Returns true when a listing is currently within its feature window AND is
 * publicly eligible to be promoted.
 *
 * Eligibility (all must hold):
 *   1. `featured_until` is a valid future instant (strictly after `now`, so an
 *      expired promotion is never featured even at the exact boundary).
 *   2. The listing is not soft-deleted.
 *   3. The listing status is 'available' (a missing status is treated as
 *      eligible so the pure-timestamp helper `isFeaturedNow` stays compatible
 *      with rows that only carry `featured_until`).
 *   4. The listing is not a draft and not hidden by moderation.
 *
 * @param row  - The property row (or a subset) to evaluate.
 * @param now  - Server-side current time. Defaults to `new Date()`.
 */
export function isFeaturedEligible(row: FeaturedEligibleRow, now: Date = new Date()): boolean {
  if (!row.featured_until) return false;

  const until = new Date(row.featured_until);
  if (Number.isNaN(until.getTime())) return false;
  // Strict comparison: a promotion whose window ends at `now` is already
  // expired and must not be presented as featured.
  if (until <= now) return false;

  // Soft-deleted listings are never featured, even if their window is open.
  if (row.deleted_at) return false;

  // Only available listings are promotable. A missing status keeps the
  // pure-timestamp path (isFeaturedNow) working for rows that only carry
  // featured_until.
  if (row.status && row.status !== 'available') return false;

  // Drafts and moderation-hidden listings are not public, so never featured.
  if (row.draft_status === 'draft') return false;
  if (row.moderation_state === 'hidden') return false;

  return true;
}

/**
 * Compute a cache TTL (ms) for a materialized set of featured rows, clamped to
 * the earliest promotion boundary so the cache can never outlive a promotion.
 *
 * Without this, a fixed TTL would serve an expired promotion as "featured"
 * for up to the full TTL after its window closed. By clamping the TTL to the
 * time remaining on the soonest-expiring promotion, the cache is invalidated
 * exactly when that promotion lapses, forcing a re-read that drops it.
 *
 * @param rows     - Featured rows whose caches should be bounded.
 * @param maxTtlMs - The nominal cache TTL (the upper bound).
 * @param now      - Server-side current time.
 * @returns A TTL in ms in the range [0, maxTtlMs]. When no row has a future
 *          `featured_until`, returns `maxTtlMs`.
 */
export function featuredExpiryTtlMs(
  rows: ReadonlyArray<Pick<FeaturedEligibleRow, 'featured_until'>>,
  maxTtlMs: number,
  now: Date = new Date(),
): number {
  let earliest = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    if (!row.featured_until) continue;
    const remaining = new Date(row.featured_until).getTime() - now.getTime();
    if (Number.isFinite(remaining) && remaining > 0 && remaining < earliest) {
      earliest = remaining;
    }
  }
  if (!Number.isFinite(earliest)) return maxTtlMs;
  // A tiny floor (50ms) avoids an immediate-expiry cache write that some
  // Redis clients reject on a 0 TTL, while still bounding the staleness.
  return Math.max(50, Math.min(maxTtlMs, Math.round(earliest)));
}
