import type { MonthlyMetric, OccupancyData } from './types';

/**
 * Shared metric definitions (must mirror the backend analytics service).
 *
 * - Earnings are reported as NET amounts: gross booking value minus platform
 *   fees and taxes, converted to the host's payout currency using the rate
 *   captured at booking time. Currency is always explicit in the metadata.
 * - Bookings count stays that were BOOKED within the window, regardless of
 *   whether they have completed yet. Cancelled bookings are excluded from
 *   both earnings and booking counts.
 * - Occupancy counts COMPLETED stay nights within the window divided by the
 *   available nights in the same window.
 * - All month boundaries are computed in the host's calendar timezone, not
 *   UTC, so a booking at 23:30 local time on the last day of a month belongs
 *   to that month.
 */

export type MetricKey = 'earnings' | 'bookings';

export interface MetricWindow {
  /** Inclusive start of the window (ISO 8601, in the host timezone). */
  start: string;
  /** Exclusive end of the window (ISO 8601, in the host timezone). */
  end: string;
  /** IANA timezone used to resolve calendar month boundaries. */
  timezone: string;
}

export interface MetricMetadata {
  metric: MetricKey;
  window: MetricWindow;
  /** ISO 4217 currency code the amounts are expressed in. */
  currency: string;
  /** Whether amounts are gross or net of fees and taxes. */
  amountBasis: 'net';
  /** Which bookings are included in the aggregate. */
  inclusion: 'booked-excluding-cancelled';
}

export interface GrowthMetric {
  current: number;
  previous: number | null;
  changePercent: number | null;
  metadata: MetricMetadata;
}

const DEFAULT_TIMEZONE = 'UTC';
const DEFAULT_CURRENCY = 'USD';

function growthBetween(current: number, previous: number | undefined): {
  current: number;
  previous: number | null;
  changePercent: number | null;
} {
  if (previous === undefined) {
    return { current, previous: null, changePercent: null };
  }
  const changePercent = previous === 0 ? 0 : ((current - previous) / previous) * 100;
  return { current, previous, changePercent };
}

/**
 * Resolve the inclusive start / exclusive end of a calendar month in the
 * given IANA timezone. Returns ISO strings that carry the correct offset.
 */
export function monthWindow(
  year: number,
  monthIndex: number,
  timezone: string = DEFAULT_TIMEZONE
): MetricWindow {
  const start = zonedMonthStart(year, monthIndex, timezone);
  const end = zonedMonthStart(year, monthIndex + 1, timezone);
  return { start, end, timezone };
}

function zonedMonthStart(year: number, monthIndex: number, timezone: string): string {
  // Normalise overflow (e.g. monthIndex 12 -> January of next year).
  const normalisedYear = year + Math.floor(monthIndex / 12);
  const normalisedMonth = ((monthIndex % 12) + 12) % 12;
  // First instant of the month in the target timezone. We build a UTC guess
  // and then correct by the timezone offset at that instant.
  const guess = Date.UTC(normalisedYear, normalisedMonth, 1, 0, 0, 0);
  const offset = timezoneOffsetMs(guess, timezone);
  return new Date(guess - offset).toISOString();
}

function timezoneOffsetMs(utcMs: number, timezone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = formatter.formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second')
  );
  return asUtc - utcMs;
}

function buildMetadata(
  metric: MetricKey,
  window: MetricWindow,
  currency: string
): MetricMetadata {
  return {
    metric,
    window,
    currency,
    amountBasis: 'net',
    inclusion: 'booked-excluding-cancelled',
  };
}

export interface GrowthOptions {
  timezone?: string;
  currency?: string;
}

export function calcMonthOverMonth(
  metrics: MonthlyMetric[],
  key: MetricKey,
  options: GrowthOptions = {}
): GrowthMetric {
  const timezone = options.timezone ?? DEFAULT_TIMEZONE;
  const currency = options.currency ?? DEFAULT_CURRENCY;
  if (metrics.length === 0) {
    return {
      current: 0,
      previous: null,
      changePercent: null,
      metadata: buildMetadata(key, monthWindow(0, 0, timezone), currency),
    };
  }
  const latest = metrics[metrics.length - 1];
  const prior = metrics[metrics.length - 2];
  const window = monthWindow(latest.year, latest.month - 1, timezone);
  return {
    ...growthBetween(latest[key], prior?.[key]),
    metadata: buildMetadata(key, window, currency),
  };
}

export function calcYearOverYear(
  metrics: MonthlyMetric[],
  key: MetricKey,
  options: GrowthOptions = {}
): GrowthMetric {
  const timezone = options.timezone ?? DEFAULT_TIMEZONE;
  const currency = options.currency ?? DEFAULT_CURRENCY;
  if (metrics.length === 0) {
    return {
      current: 0,
      previous: null,
      changePercent: null,
      metadata: buildMetadata(key, monthWindow(0, 0, timezone), currency),
    };
  }
  const latest = metrics[metrics.length - 1];
  const sameMonthLastYear = metrics[metrics.length - 1 - 12];
  const window = monthWindow(latest.year, latest.month - 1, timezone);
  return {
    ...growthBetween(latest[key], sameMonthLastYear?.[key]),
    metadata: buildMetadata(key, window, currency),
  };
}

export function calcOccupancyRate(occupancy: OccupancyData): number {
  if (occupancy.availableNights === 0) return 0;
  return (occupancy.bookedNights / occupancy.availableNights) * 100;
}

export function getPricingSuggestion(occupancyRate: number): string {
  if (occupancyRate >= 85) {
    return 'High demand: consider raising your nightly rate by 5-10%.';
  }
  if (occupancyRate <= 40) {
    return 'Low occupancy: consider lowering your nightly rate or adding promotions to attract bookings.';
  }
  return 'Occupancy is healthy: your current pricing looks well balanced.';
}
