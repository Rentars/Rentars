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
