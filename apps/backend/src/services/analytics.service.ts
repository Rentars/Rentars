/**
 * Analytics service — funnel event emission.
 *
 * Implements the event taxonomy defined in docs/ANALYTICS_TAXONOMY.md.
 *
 * Rules:
 *  - Booking and payment events are emitted server-side after confirmed
 *    state changes.  Never trust client-emitted funnel events.
 *  - user_id is omitted when the user has opted out or is unauthenticated.
 *  - Properties must not contain USDC amounts, wallet private keys,
 *    message content, or raw PII beyond what the taxonomy allows.
 *  - Every emit call is fire-and-forget: analytics failures must never
 *    block request handlers.  Errors are logged at warn level.
 *  - Events are schema-validated before insert; invalid events are
 *    discarded and logged.
 */

import { supabase } from '@/config/supabase.js';
import { structuredLog } from '@/middleware/logging.middleware.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type EventName =
  | 'search.executed'
  | 'search.zero_results'
  | 'search.suggestion_accepted'
  | 'listing.viewed'
  | 'listing.wishlisted'
  | 'booking.initiated'
  | 'booking.confirmed'
  | 'booking.cancelled'
  | 'payment.escrow_funded'
  | 'payment.escrow_released'
  | 'payment.escrow_refunded'
  | 'payment.escrow_failed'
  | 'cancellation.dispute_raised';

export interface FunnelEventPayload {
  event: EventName;
  /** Pseudonymous session identifier (never wallet address or email). */
  session_id: string;
  /** Omit when user is unauthenticated or has opted out. */
  user_id?: string;
  /** Event-specific properties — see taxonomy for allowed keys. */
  properties: Record<string, unknown>;
}

// ─── Opt-out check ────────────────────────────────────────────────────────────

/**
 * Returns true if the user has opted out of analytics.
 * Defaults to false (not opted out) if the preference row does not exist.
 */
export async function isAnalyticsOptedOut(userId: string): Promise<boolean> {
  const { data } = await supabase
    .from('user_analytics_preferences')
    .select('opted_out')
    .eq('user_id', userId)
    .maybeSingle();

  return data?.opted_out === true;
}

/**
 * Set or clear a user's analytics opt-out preference.
 */
export async function setAnalyticsOptOut(
  userId: string,
  optedOut: boolean,
): Promise<void> {
  await supabase
    .from('user_analytics_preferences')
    .upsert({ user_id: userId, opted_out: optedOut, updated_at: new Date().toISOString() });
}

// ─── Validation ───────────────────────────────────────────────────────────────

/** Keys that must never appear in any analytics event properties. */
const FORBIDDEN_KEYS = [
  'secret', 'private_key', 'seed', 'mnemonic', 'password', 'password_hash',
  'access_token', 'refresh_token', 'jwt', 'authorization',
  'message', 'body', 'content',                // user-authored text
  'total_price', 'amount_usdc', 'escrow_amount', // financial amounts
  'email', 'phone', 'full_name',                 // direct PII
];

function validateProperties(properties: Record<string, unknown>): boolean {
  for (const key of Object.keys(properties)) {
    const lower = key.toLowerCase();
    if (FORBIDDEN_KEYS.some((forbidden) => lower.includes(forbidden))) {
      structuredLog({
        level: 'warn',
        message: 'Analytics event blocked: forbidden property key',
        timestamp: new Date().toISOString(),
        key,
      });
      return false;
    }
  }
  return true;
}

// ─── Core emit ────────────────────────────────────────────────────────────────

/**
 * Emit a funnel analytics event.
 *
 * Fire-and-forget: awaiting this is optional.  It swallows all errors so
 * analytics failures never propagate to the caller.
 *
 * @example
 * // In booking.service.ts, after status update succeeds:
 * void emitFunnelEvent({
 *   event: 'booking.confirmed',
 *   session_id: sessionId,
 *   user_id: tenantId,
 *   properties: { booking_id: booking.id, property_id: booking.property_id, nights },
 * });
 */
export async function emitFunnelEvent(payload: FunnelEventPayload): Promise<void> {
  try {
    if (!validateProperties(payload.properties)) return;

    const { error } = await supabase.from('funnel_events').insert({
      event: payload.event,
      session_id: payload.session_id,
      user_id: payload.user_id ?? null,
      properties: payload.properties,
      created_at: new Date().toISOString(),
    });

    if (error) {
      structuredLog({
        level: 'warn',
        message: 'Analytics event insert failed',
        timestamp: new Date().toISOString(),
        event: payload.event,
        error: error.message,
      });
    }
  } catch (err) {
    structuredLog({
      level: 'warn',
      message: 'Analytics emit threw unexpectedly',
      timestamp: new Date().toISOString(),
      event: payload.event,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ─── Convenience emitters ─────────────────────────────────────────────────────
// These wrap emitFunnelEvent with typed property shapes so call-sites
// cannot accidentally pass wrong fields.

export interface SearchExecutedProps {
  query: string;
  filters?: Record<string, unknown>;
  result_count: number;
  sort_by?: string;
  page?: number;
}

export async function emitSearchExecuted(
  session_id: string,
  props: SearchExecutedProps,
  user_id?: string,
): Promise<void> {
  const event: EventName = props.result_count === 0 ? 'search.zero_results' : 'search.executed';
  return emitFunnelEvent({ event, session_id, user_id, properties: { ...props } });
}

export interface ListingViewedProps {
  property_id: string;
  referrer?: 'search' | 'wishlist' | 'direct' | 'share' | 'map';
  search_position?: number;
}

export async function emitListingViewed(
  session_id: string,
  props: ListingViewedProps,
  user_id?: string,
): Promise<void> {
  return emitFunnelEvent({ event: 'listing.viewed', session_id, user_id, properties: { ...props } });
}

export interface BookingInitiatedProps {
  booking_id: string;
  property_id: string;
  nights: number;
  guests: number;
  check_in: string;
  check_out: string;
}

export async function emitBookingInitiated(
  session_id: string,
  props: BookingInitiatedProps,
  user_id?: string,
): Promise<void> {
  return emitFunnelEvent({ event: 'booking.initiated', session_id, user_id, properties: { ...props } });
}

export interface BookingConfirmedProps {
  booking_id: string;
  property_id: string;
  nights: number;
}

export async function emitBookingConfirmed(
  session_id: string,
  props: BookingConfirmedProps,
  user_id?: string,
): Promise<void> {
  return emitFunnelEvent({ event: 'booking.confirmed', session_id, user_id, properties: { ...props } });
}

export interface BookingCancelledProps {
  booking_id: string;
  cancelled_by: 'tenant' | 'host' | 'system';
  reason_code?: string;
  hours_before_checkin?: number;
}

export async function emitBookingCancelled(
  session_id: string,
  props: BookingCancelledProps,
  user_id?: string,
): Promise<void> {
  return emitFunnelEvent({ event: 'booking.cancelled', session_id, user_id, properties: { ...props } });
}

export interface EscrowEventProps {
  booking_id: string;
  escrow_id: string;
  stellar_network?: string;
}

export async function emitEscrowFunded(
  session_id: string,
  props: EscrowEventProps,
  user_id?: string,
): Promise<void> {
  return emitFunnelEvent({ event: 'payment.escrow_funded', session_id, user_id, properties: { ...props } });
}

export async function emitEscrowReleased(
  session_id: string,
  props: Omit<EscrowEventProps, 'stellar_network'>,
  user_id?: string,
): Promise<void> {
  return emitFunnelEvent({ event: 'payment.escrow_released', session_id, user_id, properties: { ...props } });
}

export interface EscrowRefundedProps {
  booking_id: string;
  escrow_id: string;
  refund_type: 'full' | 'partial' | 'none';
}

export async function emitEscrowRefunded(
  session_id: string,
  props: EscrowRefundedProps,
  user_id?: string,
): Promise<void> {
  return emitFunnelEvent({ event: 'payment.escrow_refunded', session_id, user_id, properties: { ...props } });
}

export interface EscrowFailedProps {
  booking_id: string;
  operation: 'fund' | 'release' | 'refund';
  error_code?: string;
}

export async function emitEscrowFailed(
  session_id: string,
  props: EscrowFailedProps,
  user_id?: string,
): Promise<void> {
  return emitFunnelEvent({ event: 'payment.escrow_failed', session_id, user_id, properties: { ...props } });
}

// ─── Admin analytics: privacy-safe aggregate layer ────────────────────────────
//
// Standard admin reporting must only ever see aggregates.  Individual-level
// behavioural data (raw events, IPs, exact coordinates, full query strings)
// is never returned here; it is only reachable through the documented
// elevated raw-data process (see docs/ANALYTICS_TAXONOMY.md), which is
// role-gated and audited.

/** Scope required to read standard (aggregate) admin analytics. */
export const ANALYTICS_READ_SCOPE = 'admin:analytics:read';

/** Scope required for the documented elevated raw-data access path. */
export const ANALYTICS_RAW_SCOPE = 'admin:analytics:raw';

/** Hard upper bound on any admin analytics time window, in days. */
export const MAX_ANALYTICS_WINDOW_DAYS = 90;

/** Default time window when the caller does not specify one. */
export const DEFAULT_ANALYTICS_WINDOW_DAYS = 30;

/**
 * Minimum number of underlying events a group must contain before it is
 * reported.  Groups below this threshold are suppressed to prevent
 * re-identification of small cohorts.  Configurable via
 * ADMIN_ANALYTICS_MIN_COHORT (default 10).
 */
export function getMinCohortSize(): number {
  const raw = process.env.ADMIN_ANALYTICS_MIN_COHORT;
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 10;
  return parsed;
}

/**
 * Allowlisted filter fields for admin analytics queries.  Anything not in
 * this list is rejected — arbitrary filtering is not permitted.
 */
export const ALLOWED_ANALYTICS_FILTERS = ['event', 'property_id'] as const;
export type AnalyticsFilterField = (typeof ALLOWED_ANALYTICS_FILTERS)[number];

export type AnalyticsFilters = Partial<Record<AnalyticsFilterField, string>>;

/** Caller identity/authorization context for admin analytics requests. */
export interface AnalyticsActor {
  userId: string;
  scopes: readonly string[];
}

export class AnalyticsAuthorizationError extends Error {
  constructor(message = 'Not authorized to access analytics') {
    super(message);
    this.name = 'AnalyticsAuthorizationError';
  }
}

export class AnalyticsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalyticsValidationError';
  }
}

function assertScope(actor: AnalyticsActor, scope: string): void {
  if (!actor || !Array.isArray(actor.scopes) || !actor.scopes.includes(scope)) {
    structuredLog({
      level: 'warn',
      message: 'Analytics access denied: missing scope',
      timestamp: new Date().toISOString(),
      user_id: actor?.userId ?? null,
      required_scope: scope,
    });
    throw new AnalyticsAuthorizationError();
  }
}

/**
 * Clamp and validate a requested time window.  Rejects non-positive or
 * non-finite windows and caps at MAX_ANALYTICS_WINDOW_DAYS.
 */
export function resolveWindowDays(requested?: number): number {
  if (requested === undefined) return DEFAULT_ANALYTICS_WINDOW_DAYS;
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new AnalyticsValidationError('Time window must be a positive number of days');
  }
  return Math.min(Math.floor(requested), MAX_ANALYTICS_WINDOW_DAYS);
}

function validateFilters(filters?: AnalyticsFilters): AnalyticsFilters {
  if (!filters) return {};
  const clean: AnalyticsFilters = {};
  for (const [key, value] of Object.entries(filters)) {
    if (!(ALLOWED_ANALYTICS_FILTERS as readonly string[]).includes(key)) {
      throw new AnalyticsValidationError(`Filter field not allowed: ${key}`);
    }
    if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
      throw new AnalyticsValidationError(`Invalid filter value for: ${key}`);
    }
    clean[key as AnalyticsFilterField] = value;
  }
  return clean;
}

/**
 * Normalize a free-text search query for aggregation.  Full query strings
 * are never returned; only a short, lowercased, whitespace-collapsed token
 * capped at 40 characters.
 */
export function normalizeQueryForAggregation(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 40);
}

export interface FunnelSummary {
  searches: number;
  booking_initiations: number;
  booking_confirmations: number;
  escrow_funded: number;
  escrow_released: number;
  escrow_refunded: number;
  escrow_failed: number;
}

/**
 * Return aggregate funnel counts for the past N days.
 * Does not expose user_id or session_id — safe for dashboard display.
 */
export async function getFunnelSummary(days = 30): Promise<FunnelSummary> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('funnel_events')
    .select('event')
    .gte('created_at', since);

  if (error || !data) {
    structuredLog({ level: 'warn', message: 'getFunnelSummary query failed', timestamp: new Date().toISOString(), error: error?.message });
    return {
      searches: 0, booking_initiations: 0, booking_confirmations: 0,
      escrow_funded: 0, escrow_released: 0, escrow_refunded: 0, escrow_failed: 0,
    };
  }

  const count = (name: EventName) => data.filter((r) => r.event === name).length;

  return {
    searches:              count('search.executed') + count('search.zero_results'),
    booking_initiations:   count('booking.initiated'),
    booking_confirmations: count('booking.confirmed'),
    escrow_funded:         count('payment.escrow_funded'),
    escrow_released:       count('payment.escrow_released'),
    escrow_refunded:       count('payment.escrow_refunded'),
    escrow_failed:         count('payment.escrow_failed'),
  };
}

/** A single aggregated group.  `suppressed` groups carry no count. */
export interface AggregateGroup {
  key: string;
  count: number | null;
  suppressed: boolean;
}

export interface AdminFunnelReport {
  window_days: number;
  min_cohort: number;
  total_events: number;
  total_suppressed: boolean;
  by_event: AggregateGroup[];
}

/**
 * Privacy-safe aggregate funnel report for admin dashboards.
 *
 * - Requires the `admin:analytics:read` scope.
 * - Only allowlisted filters are accepted.
 * - Time window is bounded to MAX_ANALYTICS_WINDOW_DAYS.
 * - Groups with fewer than the minimum cohort size are suppressed.
 * - Returns counts only — never user_id, session_id, IPs, coordinates or
 *   full query strings.
 */
export async function getAdminFunnelReport(
  actor: AnalyticsActor,
  options: { windowDays?: number; filters?: AnalyticsFilters } = {},
): Promise<AdminFunnelReport> {
  assertScope(actor, ANALYTICS_READ_SCOPE);

  const windowDays = resolveWindowDays(options.windowDays);
  const filters = validateFilters(options.filters);
  const minCohort = getMinCohortSize();
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  let query = supabase
    .from('funnel_events')
    .select('event')
    .gte('created_at', since);

  if (filters.event) query = query.eq('event', filters.event);
  if (filters.property_id) query = query.eq('properties->>property_id', filters.property_id);

  const { data, error } = await query;

  if (error || !data) {
    structuredLog({
      level: 'warn',
      message: 'getAdminFunnelReport query failed',
      timestamp: new Date().toISOString(),
      error: error?.message,
    });
    return {
      window_days: windowDays,
      min_cohort: minCohort,
      total_events: 0,
      total_suppressed: true,
      by_event: [],
    };
  }

  const counts = new Map<string, number>();
  for (const row of data) {
    counts.set(row.event, (counts.get(row.event) ?? 0) + 1);
  }

  const by_event: AggregateGroup[] = [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, count]) =>
      count < minCohort
        ? { key, count: null, suppressed: true }
        : { key, count, suppressed: false },
    );

  const totalEvents = data.length;

  structuredLog({
    level: 'info',
    message: 'Admin analytics aggregate report generated',
    timestamp: new Date().toISOString(),
    user_id: actor.userId,
    scope: ANALYTICS_READ_SCOPE,
    window_days: windowDays,
    filters,
  });

  return {
    window_days: windowDays,
    min_cohort: minCohort,
    total_events: totalEvents < minCohort ? 0 : totalEvents,
    total_suppressed: totalEvents < minCohort,
    by_event,
  };
}

/**
 * Documented elevated raw-data access path.
 *
 * Raw event rows are only available to holders of `admin:analytics:raw`,
 * require a documented purpose, are bounded to MAX_ANALYTICS_WINDOW_DAYS,
 * and every access is audit-logged.  Even here, raw IPs, exact coordinates
 * and full query strings are stripped from the response.
 */
export async function getRawAnalyticsEvents(
  actor: AnalyticsActor,
  options: { windowDays?: number; purpose: string; limit?: number },
): Promise<Array<Record<string, unknown>>> {
  assertScope(actor, ANALYTICS_RAW_SCOPE);

  if (!options.purpose || options.purpose.trim().length < 10) {
    throw new AnalyticsValidationError('A documented purpose is required for raw analytics access');
  }

  const windowDays = resolveWindowDays(options.windowDays);
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  structuredLog({
    level: 'warn',
    message: 'Elevated raw analytics access',
    timestamp: new Date().toISOString(),
    user_id: actor.userId,
    scope: ANALYTICS_RAW_SCOPE,
    purpose: options.purpose,
    window_days: windowDays,
    limit,
  });

  const { data, error } = await supabase
    .from('funnel_events')
    .select('event, properties, created_at')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error || !data) {
    structuredLog({
      level: 'warn',
      message: 'getRawAnalyticsEvents query failed',
      timestamp: new Date().toISOString(),
      error: error?.message,
    });
    return [];
  }

  const FORBIDDEN_RAW_KEYS = ['ip', 'ip_address', 'latitude', 'longitude', 'lat', 'lng', 'query', 'user_id', 'session_id'];

  return data.map((row) => {
    const props = (row.properties ?? {}) as Record<string, unknown>;
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      if (FORBIDDEN_RAW_KEYS.includes(key.toLowerCase())) continue;
      sanitized[key] = value;
    }
    return { event: row.event, properties: sanitized, created_at: row.created_at };
  });
}
