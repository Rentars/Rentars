/**
 * Test clock utilities and fixtures.
 *
 * Provides common date/time values and helpers for time-dependent tests.
 */

import { Clock } from '@/utils/clock.js';

/**
 * Common test timestamps
 */
export const TEST_DATES = {
  NOW: new Date('2027-06-15T14:30:00Z'),
  PAST_1H: new Date('2027-06-15T13:30:00Z'),
  PAST_24H: new Date('2027-06-14T14:30:00Z'),
  PAST_48H: new Date('2027-06-13T14:30:00Z'),
  PAST_7D: new Date('2027-06-08T14:30:00Z'),
  FUTURE_1H: new Date('2027-06-15T15:30:00Z'),
  FUTURE_24H: new Date('2027-06-16T14:30:00Z'),
  FUTURE_48H: new Date('2027-06-17T14:30:00Z'),
  FUTURE_7D: new Date('2027-06-22T14:30:00Z'),
} as const;

/**
 * Setup helper for tests that need deterministic time.
 *
 * Usage:
 *   beforeEach(() => {
 *     withFixedTime(TEST_DATES.NOW);
 *   });
 *   afterEach(() => {
 *     resetClock();
 *   });
 */
export function withFixedTime(time: Date = TEST_DATES.NOW): void {
  Clock.setFixed(time);
}

/**
 * Cleanup helper to reset clock to real time.
 */
export function resetClock(): void {
  Clock.reset();
}

/**
 * Advance the test clock by a duration.
 *
 * @param ms - Milliseconds to advance
 */
export function advanceClock(ms: number): void {
  Clock.advance(ms);
}

/**
 * Advance clock by hours.
 */
export function advanceHours(hours: number): void {
  Clock.advance(hours * 3_600_000);
}

/**
 * Advance clock by days.
 */
export function advanceDays(days: number): void {
  Clock.advance(days * 86_400_000);
}

/**
 * Returns current test time as ISO string.
 */
export function nowISO(): string {
  return Clock.date().toISOString();
}

/**
 * Returns current test time as Unix timestamp (ms).
 */
export function nowTimestamp(): number {
  return Clock.now();
}

/**
 * Creates a date relative to test NOW.
 */
export function relativeDate(offsetMs: number): Date {
  return new Date(Clock.now() + offsetMs);
}

/**
 * Time duration constants (milliseconds)
 */
export const DURATION = {
  SECOND: 1_000,
  MINUTE: 60_000,
  HOUR: 3_600_000,
  DAY: 86_400_000,
  WEEK: 604_800_000,
} as const;

/**
 * Assert that a date is within acceptable tolerance of expected.
 *
 * @param actual - Date to check
 * @param expected - Expected date
 * @param toleranceMs - Allowed difference in milliseconds (default: 1000)
 */
export function assertDateNear(
  actual: Date | string,
  expected: Date | string,
  toleranceMs = 1000
): void {
  const actualMs = typeof actual === 'string' ? new Date(actual).getTime() : actual.getTime();
  const expectedMs = typeof expected === 'string' ? new Date(expected).getTime() : expected.getTime();
  const diff = Math.abs(actualMs - expectedMs);

  if (diff > toleranceMs) {
    throw new Error(
      `Date ${new Date(actualMs).toISOString()} is not within ${toleranceMs}ms of ${new Date(expectedMs).toISOString()} (diff: ${diff}ms)`
    );
  }
}
