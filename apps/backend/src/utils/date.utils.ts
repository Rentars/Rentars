/**
 * Property-local calendar date utilities (#762).
 *
 * Rental dates (check_in / check_out) are calendar values — "this property,
 * this day" — not instants. Storage/chain timestamps are instants. Parsing a
 * calendar date with `new Date(str)` and diffing in milliseconds is wrong in
 * two ways:
 *
 *   1. A bare "YYYY-MM-DD" string is parsed as UTC midnight, but a
 *      datetime-looking string without a "Z"/offset suffix is parsed as
 *      *local* midnight (engine-dependent). Mixing the two silently shifts
 *      a date by a day near DST boundaries or for callers in non-UTC zones.
 *   2. Diffing two `Date` instants in milliseconds and dividing by
 *      86_400_000 undercounts or overcounts nights across a DST transition,
 *      because that calendar day was 23 or 25 hours long in local time (it
 *      is always exactly 24h only when both instants are UTC midnights).
 *
 * The fix: treat check_in/check_out as plain calendar dates, always
 * normalized and diffed as UTC calendar days (YYYY-MM-DD, no wall-clock
 * time), independent of the host process's local timezone and independent
 * of any DST transition the property's own timezone might observe. This
 * keeps leap days and DST changes from ever affecting a night count.
 */

const CALENDAR_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A validated, canonical property-local calendar date: "YYYY-MM-DD". */
export type CalendarDate = string;

/**
 * Normalize an input into a canonical "YYYY-MM-DD" calendar date.
 *
 * Accepts a bare date ("2024-03-10"), a full ISO instant
 * ("2024-03-10T00:00:00Z" / with any offset), or a Date object, and always
 * returns the calendar date that was intended — never shifted by the local
 * timezone of the process running this code.
 *
 * Returns null if the input is not a valid calendar date (including
 * out-of-range values like "2024-02-30" or "2023-02-29", which
 * `Date.UTC`/`new Date` would otherwise silently roll forward).
 */
export function toCalendarDate(input: string | Date | null | undefined): CalendarDate | null {
  if (input == null) return null;

  if (input instanceof Date) {
    if (isNaN(input.getTime())) return null;
    return formatCalendarDate(input.getUTCFullYear(), input.getUTCMonth() + 1, input.getUTCDate());
  }

  const trimmed = input.trim();
  const bareMatch = CALENDAR_DATE_RE.exec(trimmed);
  const datePart = bareMatch ? trimmed : trimmed.split('T')[0];
  const m = CALENDAR_DATE_RE.exec(datePart);
  if (!m) return null;

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);

  if (!isValidYmd(year, month, day)) return null;

  return formatCalendarDate(year, month, day);
}

/** True iff (year, month, day) is a real calendar date, leap years included. */
function isValidYmd(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  // Round-trip through Date.UTC and check it didn't roll over (e.g. Feb 30 -> Mar 2).
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

function formatCalendarDate(year: number, month: number, day: number): CalendarDate {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Parse a canonical calendar date into a UTC-midnight Date instant (for arithmetic only). */
function toUtcMidnight(date: CalendarDate): Date {
  const m = CALENDAR_DATE_RE.exec(date);
  if (!m) throw new RangeError(`Not a canonical calendar date: ${date}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

/**
 * Epoch seconds for a canonical calendar date's UTC midnight instant. Used
 * where a calendar date must be passed to a chain/contract call expecting a
 * Unix timestamp — always the same instant regardless of the caller's local
 * timezone or any DST transition.
 */
export function calendarDateToEpochSeconds(date: CalendarDate): bigint {
  return BigInt(Math.floor(toUtcMidnight(date).getTime() / 1000));
}

/**
 * Number of nights between two canonical calendar dates (checkout - checkin),
 * counted as whole calendar days — immune to DST, since both endpoints are
 * UTC midnights representing calendar days, never wall-clock instants in a
 * timezone that observes DST.
 *
 * Throws if either argument is not already a canonical "YYYY-MM-DD" string;
 * callers must normalize with `toCalendarDate` first.
 */
export function nightsBetween(checkIn: CalendarDate, checkOut: CalendarDate): number {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.round((toUtcMidnight(checkOut).getTime() - toUtcMidnight(checkIn).getTime()) / MS_PER_DAY);
}

/** True iff `a` is strictly before `b` as calendar dates. */
export function isBeforeCalendarDate(a: CalendarDate, b: CalendarDate): boolean {
  return a < b; // canonical "YYYY-MM-DD" strings compare lexicographically = chronologically
}

/**
 * Normalize and validate a check-in/check-out pair at an API boundary.
 * Returns the canonical pair plus night count, or a field-specific error.
 *
 * Checkout is exclusive (the night of checkout is not occupied) and
 * check-in is inclusive, matching standard hospitality semantics and the
 * existing booking-overlap exclusion constraint.
 */
export function normalizeStayRange(
  checkInInput: string,
  checkOutInput: string,
): { checkIn: CalendarDate; checkOut: CalendarDate; nights: number } | { error: string; field: 'check_in' | 'check_out' } {
  const checkIn = toCalendarDate(checkInInput);
  if (!checkIn) return { error: 'check_in must be a valid calendar date (YYYY-MM-DD)', field: 'check_in' };

  const checkOut = toCalendarDate(checkOutInput);
  if (!checkOut) return { error: 'check_out must be a valid calendar date (YYYY-MM-DD)', field: 'check_out' };

  if (!isBeforeCalendarDate(checkIn, checkOut)) {
    return { error: 'check_in must be before check_out', field: 'check_out' };
  }

  return { checkIn, checkOut, nights: nightsBetween(checkIn, checkOut) };
}

// ---------------------------------------------------------------------------
// Host analytics shared calculation windows (#982 / Issue 087)
//
// Host dashboards (earnings, occupancy, property views, comparative growth)
// must agree on: which calendar days a window covers, which timezone those
// days are interpreted in, which bookings count (booked vs completed), and
// whether money is gross or net. These helpers are the single source of truth
// for all of that; every aggregate should carry the metadata they build.
// ---------------------------------------------------------------------------

/** Inclusive calendar-day window, expressed in the analytics timezone. */
export interface AnalyticsRange {
  /** First calendar day included in the window (inclusive). */
  startDate: CalendarDate;
  /** Last calendar day included in the window (inclusive). */
  endDate: CalendarDate;
  /** IANA timezone the calendar days are interpreted in. */
  timezone: string;
  /** Number of calendar days covered (endDate - startDate + 1). */
  days: number;
  /** UTC instant at which the window opens (start of startDate in `timezone`). */
  startUtc: Date;
  /** UTC instant at which the window closes (exclusive; start of day after endDate). */
  endUtc: Date;
  /** True when the window was clamped to "today" (i.e. it includes the current day). */
  partial: boolean;
}

/** Which bookings are counted in an aggregate. */
export type BookingInclusion = 'booked' | 'completed';

/** Whether monetary amounts are before or after fees/refunds. */
export type AmountBasis = 'gross' | 'net';

/** Metadata attached to every analytics aggregate so cards/charts/exports agree. */
export interface MetricMetadata {
  metric: string;
  range: {
    startDate: CalendarDate;
    endDate: CalendarDate;
    days: number;
    partial: boolean;
    startUtc: string;
    endUtc: string;
  };
  timezone: string;
  bookingInclusion: BookingInclusion;
  amountBasis: AmountBasis;
  currency: string;
  /** Human-readable definition, identical across widgets and exports. */
  definition: string;
}

const DEFAULT_ANALYTICS_TIMEZONE = 'UTC';
const MAX_ANALYTICS_RANGE_DAYS = 3660; // ~10 years; guards against absurd inputs

/**
 * Resolve the analytics timezone. Accepts an IANA zone name; falls back to
 * UTC when unset or invalid so a bad client value can never shift windows.
 */
export function resolveTimezone(input?: string | null): string {
  if (!input) return DEFAULT_ANALYTICS_TIMEZONE;
  const candidate = input.trim();
  if (!candidate) return DEFAULT_ANALYTICS_TIMEZONE;
  try {
    // Intl throws RangeError for unknown zones; also rejects non-IANA junk.
    new Intl.DateTimeFormat('en-US', { timeZone: candidate });
    return candidate;
  } catch {
    return DEFAULT_ANALYTICS_TIMEZONE;
  }
}

/** Offset (ms) of `timezone` from UTC at the given instant. */
function timezoneOffsetMs(instant: Date, timezone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(instant);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  );
  return asUtc - instant.getTime();
}

/** UTC instant for the start (00:00:00) of a calendar date in `timezone`. */
export function startOfDayInTimezone(date: CalendarDate, timezone: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const naiveUtc = Date.UTC(y, m - 1, d, 0, 0, 0, 0);
  // Two-pass correction handles DST transitions where the offset changes.
  let offset = timezoneOffsetMs(new Date(naiveUtc), timezone);
  offset = timezoneOffsetMs(new Date(naiveUtc - offset), timezone);
  return new Date(naiveUtc - offset);
}

/** Add `days` calendar days to a canonical calendar date. */
export function addCalendarDays(date: CalendarDate, days: number): CalendarDate {
  const base = toUtcMidnight(date);
  const shifted = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
  return formatCalendarDate(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

/** Inclusive day count between two canonical calendar dates. */
export function calendarDaysInclusive(start: CalendarDate, end: CalendarDate): number {
  return nightsBetween(start, end) + 1;
}

export interface ParseAnalyticsRangeInput {
  /** Inclusive start date ("YYYY-MM-DD" or ISO instant). Defaults to 30 days before `end`. */
  startDate?: string | Date | null;
  /** Inclusive end date ("YYYY-MM-DD" or ISO instant). Defaults to "today" in `timezone`. */
  endDate?: string | Date | null;
  /** IANA timezone; defaults to UTC. */
  timezone?: string | null;
  /** "Now" override for deterministic tests. */
  now?: Date;
  /** Default window length (days) when `startDate` is omitted. */
  defaultDays?: number;
}

/**
 * Parse and normalize a host analytics date window. All dashboard widgets,
 * charts and exports must use this so boundaries are identical everywhere.
 *
 * - Both endpoints are inclusive calendar days in `timezone`.
 * - Missing `endDate` = today in `timezone`; missing `startDate` = `defaultDays`
 *   before the end (inclusive), so a 30-day window covers 30 calendar days.
 * - Windows are clamped so they never extend past today (partial periods are
 *   flagged via `partial` rather than silently truncated).
 *
 * Throws RangeError for unparseable dates or inverted ranges.
 */
export function parseAnalyticsRange(input: ParseAnalyticsRangeInput = {}): AnalyticsRange {
  const timezone = resolveTimezone(input.timezone);
  const now = input.now ?? new Date();
  const today = toCalendarDate(now);
  if (!today) throw new RangeError('Unable to resolve current date');

  const endDate = input.endDate != null ? toCalendarDate(input.endDate) : today;
  if (!endDate) throw new RangeError('endDate must be a valid calendar date (YYYY-MM-DD)');

  const defaultDays = Math.max(1, Math.floor(input.defaultDays ?? 30));
  const startDate =
    input.startDate != null
      ? toCalendarDate(input.startDate)
      : addCalendarDays(endDate, -(defaultDays - 1));
  if (!startDate) throw new RangeError('startDate must be a valid calendar date (YYYY-MM-DD)');

  if (isBeforeCalendarDate(endDate, startDate)) {
    throw new RangeError('startDate must be on or before endDate');
  }

  const days = calendarDaysInclusive(startDate, endDate);
  if (days > MAX_ANALYTICS_RANGE_DAYS) {
    throw new RangeError(`Analytics range exceeds ${MAX_ANALYTICS_RANGE_DAYS} days`);
  }

  return {
    startDate,
    endDate,
    timezone,
    days,
    startUtc: startOfDayInTimezone(startDate, timezone),
    endUtc: startOfDayInTimezone(addCalendarDays(endDate, 1), timezone),
    partial: !isBeforeCalendarDate(endDate, today),
  };
}

export interface BuildMetricMetadataInput {
  /** Metric identifier, e.g. "earnings", "occupancy", "views", "growth". */
  metric: string;
  /** Window the aggregate was computed over (from `parseAnalyticsRange`). */
  range: AnalyticsRange;
  /** Which bookings were counted. Defaults to "completed". */
  bookingInclusion?: BookingInclusion;
  /** Whether amounts are gross or net. Defaults to "net". */
  amountBasis?: AmountBasis;
  /** ISO 4217 currency code. Defaults to "USD". */
  currency?: string | null;
  /** Optional override for the human-readable definition. */
  definition?: string;
}

const DEFAULT_DEFINITIONS: Record<string, string> = {
  earnings:
    'Sum of amounts for counted bookings whose stay overlaps the window, in the reported currency and amount basis.',
  occupancy:
    'Booked nights divided by available nights in the window; nights counted per calendar day in the analytics timezone.',
  views:
    'Total property detail views recorded within the window (inclusive start, exclusive end instant).',
  growth:
    'Percent change of the metric versus the immediately preceding window of equal length.',
};

/**
 * Build the metadata block returned alongside every analytics aggregate so
 * cards, charts and exports share one definition of the metric.
 */
export function buildMetricMetadata(input: BuildMetricMetadataInput): MetricMetadata {
  const { range } = input;
  const bookingInclusion: BookingInclusion = input.bookingInclusion ?? 'completed';
  const amountBasis: AmountBasis = input.amountBasis ?? 'net';
  const currency = (input.currency ?? 'USD').trim().toUpperCase() || 'USD';
  const definition =
    input.definition ??
    DEFAULT_DEFINITIONS[input.metric] ??
    `Aggregate "${input.metric}" computed over the reported window and inclusion rules.`;

  return {
    metric: input.metric,
    range: {
      startDate: range.startDate,
      endDate: range.endDate,
      days: range.days,
      partial: range.partial,
      startUtc: range.startUtc.toISOString(),
      endUtc: range.endUtc.toISOString(),
    },
    timezone: range.timezone,
    bookingInclusion,
    amountBasis,
    currency,
    definition,
  };
}
