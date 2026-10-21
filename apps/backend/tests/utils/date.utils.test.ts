import {
  toCalendarDate,
  nightsBetween,
  isBeforeCalendarDate,
  normalizeStayRange,
} from '../../src/utils/date.utils';

// ---------------------------------------------------------------------------
// toCalendarDate — normalization and validation (issue #762)
// ---------------------------------------------------------------------------

describe('toCalendarDate', () => {
  it('passes through a bare calendar date unchanged', () => {
    expect(toCalendarDate('2024-03-10')).toBe('2024-03-10');
  });

  it('extracts the calendar date from a full UTC instant', () => {
    expect(toCalendarDate('2024-03-10T00:00:00Z')).toBe('2024-03-10');
  });

  it('extracts the calendar date from an instant with a positive offset', () => {
    expect(toCalendarDate('2024-03-10T23:30:00+05:00')).toBe('2024-03-10');
  });

  it('round-trips a leap-day date (2024 is a leap year)', () => {
    expect(toCalendarDate('2024-02-29')).toBe('2024-02-29');
  });

  it('rejects a non-leap-year Feb 29 instead of silently rolling to Mar 1', () => {
    expect(toCalendarDate('2023-02-29')).toBeNull();
  });

  it('rejects an out-of-range day instead of silently rolling over', () => {
    expect(toCalendarDate('2024-04-31')).toBeNull();
  });

  it('rejects garbage input', () => {
    expect(toCalendarDate('not-a-date')).toBeNull();
    expect(toCalendarDate('')).toBeNull();
    expect(toCalendarDate(null)).toBeNull();
    expect(toCalendarDate(undefined)).toBeNull();
  });

  it('normalizes a Date object using its UTC calendar fields', () => {
    const d = new Date(Date.UTC(2024, 10, 3)); // Nov 3, 2024 (US DST fall-back date)
    expect(toCalendarDate(d)).toBe('2024-11-03');
  });
});

// ---------------------------------------------------------------------------
// nightsBetween — DST and leap-day boundaries must not change the count
// ---------------------------------------------------------------------------

describe('nightsBetween', () => {
  it('counts a single night for adjacent calendar dates', () => {
    expect(nightsBetween('2024-03-10', '2024-03-11')).toBe(1);
  });

  it('is unaffected by the US spring-forward DST boundary (Mar 10 2024)', () => {
    // Local wall-clock time loses an hour on this date in US timezones; a
    // ms-based diff of two local-midnight Dates would undercount.
    expect(nightsBetween('2024-03-09', '2024-03-11')).toBe(2);
  });

  it('is unaffected by the US fall-back DST boundary (Nov 3 2024)', () => {
    // Local wall-clock time gains an hour on this date; a ms-based diff
    // would overcount.
    expect(nightsBetween('2024-11-02', '2024-11-04')).toBe(2);
  });

  it('is unaffected by a leap-day boundary (Feb 2024)', () => {
    expect(nightsBetween('2024-02-28', '2024-03-01')).toBe(2);
  });

  it('is unaffected by a non-leap-year February boundary', () => {
    expect(nightsBetween('2023-02-27', '2023-03-01')).toBe(2);
  });

  it('counts a long stay across a year boundary', () => {
    expect(nightsBetween('2024-12-30', '2025-01-02')).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// isBeforeCalendarDate
// ---------------------------------------------------------------------------

describe('isBeforeCalendarDate', () => {
  it('orders dates lexicographically/chronologically', () => {
    expect(isBeforeCalendarDate('2024-02-28', '2024-02-29')).toBe(true);
    expect(isBeforeCalendarDate('2024-12-31', '2025-01-01')).toBe(true);
    expect(isBeforeCalendarDate('2024-03-10', '2024-03-10')).toBe(false);
    expect(isBeforeCalendarDate('2024-03-11', '2024-03-10')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// normalizeStayRange — API boundary normalization (issue #762)
// ---------------------------------------------------------------------------

describe('normalizeStayRange', () => {
  it('normalizes a valid UTC-offset pair spanning a DST boundary', () => {
    const result = normalizeStayRange('2024-03-09T22:00:00-05:00', '2024-03-11T22:00:00-05:00');
    expect(result).toEqual({ checkIn: '2024-03-10', checkOut: '2024-03-12', nights: 2 });
  });

  it('rejects equal check_in/check_out with a field-specific message', () => {
    const result = normalizeStayRange('2024-03-10', '2024-03-10');
    expect('error' in result && result.field).toBe('check_out');
  });

  it('rejects check_out before check_in with a field-specific message', () => {
    const result = normalizeStayRange('2024-03-12', '2024-03-10');
    expect('error' in result && result.field).toBe('check_out');
  });

  it('rejects an invalid check_in with a field-specific message', () => {
    const result = normalizeStayRange('not-a-date', '2024-03-12');
    expect('error' in result && result.field).toBe('check_in');
  });

  it('rejects an invalid check_out with a field-specific message', () => {
    const result = normalizeStayRange('2024-03-10', 'not-a-date');
    expect('error' in result && result.field).toBe('check_out');
  });

  it('allows two adjacent bookings to share a turnover date without conflict', () => {
    // Booking A: Mar 10 -> Mar 12. Booking B: Mar 12 -> Mar 14.
    // Checkout is exclusive, so these are adjacent, not overlapping.
    const a = normalizeStayRange('2024-03-10', '2024-03-12');
    const b = normalizeStayRange('2024-03-12', '2024-03-14');
    expect('checkOut' in a && a.checkOut).toBe('2024-03-12');
    expect('checkIn' in b && b.checkIn).toBe('2024-03-12');
  });
});
