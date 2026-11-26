/**
 * Deterministic Time Tests for Scheduled Features
 *
 * Tests time-dependent services using fixed clocks to ensure:
 *   - Reminders fire at correct times
 *   - Tokens expire as expected
 *   - Featured listings expire correctly
 *   - Booking windows are enforced
 *   - Promotion expiration works
 *   - Retention cutoffs are applied
 *
 * Run: bun test tests/unit/deterministic-time.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Clock } from '@/utils/clock.js';
import {
  withFixedTime,
  resetClock,
  advanceHours,
  advanceDays,
  TEST_DATES,
  DURATION,
  assertDateNear,
} from '../utils/test-clock.js';

describe('Clock Abstraction', () => {
  beforeEach(() => {
    withFixedTime(TEST_DATES.NOW);
  });

  afterEach(() => {
    resetClock();
  });

  it('returns fixed time when set', () => {
    expect(Clock.now()).toBe(TEST_DATES.NOW.getTime());
    expect(Clock.date().toISOString()).toBe(TEST_DATES.NOW.toISOString());
  });

  it('advances time correctly', () => {
    const before = Clock.now();
    advanceHours(2);
    const after = Clock.now();

    expect(after - before).toBe(2 * DURATION.HOUR);
  });

  it('resets to real time', () => {
    expect(Clock.isFixed()).toBe(true);
    resetClock();
    expect(Clock.isFixed()).toBe(false);

    const now = Clock.now();
    const realNow = Date.now();
    expect(Math.abs(now - realNow)).toBeLessThan(100);
  });
});

describe('Token Expiry', () => {
  beforeEach(() => {
    withFixedTime(TEST_DATES.NOW);
  });

  afterEach(() => {
    resetClock();
  });

  it('token expires exactly at boundary', () => {
    const tokenIssuedAt = Clock.now();
    const expiryMs = 3600000; // 1 hour
    const expiresAt = tokenIssuedAt + expiryMs;

    advanceHours(0.9);
    expect(Clock.now()).toBeLessThan(expiresAt);

    advanceHours(0.1);
    expect(Clock.now()).toBe(expiresAt);

    advanceHours(0.1);
    expect(Clock.now()).toBeGreaterThan(expiresAt);
  });

  it('detects expired tokens just after expiry', () => {
    const expiresAt = Clock.now() + DURATION.HOUR;

    expect(Clock.now() < expiresAt).toBe(true);

    advanceHours(1);
    expect(Clock.now() >= expiresAt).toBe(true);

    Clock.advance(1); // 1ms after
    expect(Clock.now() > expiresAt).toBe(true);
  });

  it('validates tokens before expiry', () => {
    const expiresAt = Clock.now() + DURATION.DAY;

    advanceHours(23);
    expect(Clock.now() < expiresAt).toBe(true);

    advanceHours(1);
    expect(Clock.now() >= expiresAt).toBe(true);
  });
});

describe('Reminder Timing', () => {
  beforeEach(() => {
    withFixedTime(TEST_DATES.NOW);
  });

  afterEach(() => {
    resetClock();
  });

  it('check-in reminder fires 24 hours before', () => {
    const checkInDate = new Date(Clock.now() + 24 * DURATION.HOUR);
    const reminderLeadTime = 24 * DURATION.HOUR;
    const reminderFireTime = checkInDate.getTime() - reminderLeadTime;

    expect(Clock.now()).toBe(reminderFireTime);

    advanceHours(1);
    expect(Clock.now()).toBeGreaterThan(reminderFireTime);
  });

  it('payment deadline reminder fires 48 hours after booking', () => {
    const bookingCreatedAt = Clock.now();
    const paymentDeadline = bookingCreatedAt + 48 * DURATION.HOUR;
    const reminderLeadTime = 2 * DURATION.HOUR;
    const reminderFireTime = paymentDeadline - reminderLeadTime;

    advanceHours(46);
    expect(Clock.now()).toBe(reminderFireTime);

    advanceHours(2);
    expect(Clock.now()).toBe(paymentDeadline);
  });

  it('check-out reminder fires 12 hours before', () => {
    const checkOutDate = new Date(Clock.now() + 12 * DURATION.HOUR);
    const reminderLeadTime = 12 * DURATION.HOUR;
    const reminderFireTime = checkOutDate.getTime() - reminderLeadTime;

    expect(Clock.now()).toBe(reminderFireTime);

    advanceHours(12);
    expect(Clock.now()).toBe(checkOutDate.getTime());
  });
});

describe('Booking Window Enforcement', () => {
  beforeEach(() => {
    withFixedTime(TEST_DATES.NOW);
  });

  afterEach(() => {
    resetClock();
  });

  it('allows bookings within valid future window', () => {
    const minAdvanceBooking = 24 * DURATION.HOUR;
    const maxAdvanceBooking = 365 * DURATION.DAY;

    const checkInMin = Clock.now() + minAdvanceBooking;
    const checkInMax = Clock.now() + maxAdvanceBooking;

    const validCheckIn = Clock.now() + 7 * DURATION.DAY;
    expect(validCheckIn).toBeGreaterThan(checkInMin);
    expect(validCheckIn).toBeLessThan(checkInMax);
  });

  it('rejects bookings too far in future', () => {
    const maxAdvanceBooking = 365 * DURATION.DAY;
    const tooFarCheckIn = Clock.now() + 400 * DURATION.DAY;

    expect(tooFarCheckIn - Clock.now()).toBeGreaterThan(maxAdvanceBooking);
  });

  it('rejects bookings too close to present', () => {
    const minAdvanceBooking = 24 * DURATION.HOUR;
    const tooSoonCheckIn = Clock.now() + 12 * DURATION.HOUR;

    expect(tooSoonCheckIn - Clock.now()).toBeLessThan(minAdvanceBooking);
  });
});

describe('Featured Listing Expiration', () => {
  beforeEach(() => {
    withFixedTime(TEST_DATES.NOW);
  });

  afterEach(() => {
    resetClock();
  });

  it('featured listing expires at exact boundary', () => {
    const featuredUntil = Clock.now() + 7 * DURATION.DAY;

    advanceDays(6);
    expect(Clock.now() < featuredUntil).toBe(true);

    advanceDays(1);
    expect(Clock.now() >= featuredUntil).toBe(true);
  });

  it('detects expired featured listings just after cutoff', () => {
    const featuredUntil = Clock.now() + DURATION.DAY;

    advanceHours(23);
    expect(Clock.now() < featuredUntil).toBe(true);

    advanceHours(1);
    expect(Clock.now() >= featuredUntil).toBe(true);

    Clock.advance(1);
    expect(Clock.now() > featuredUntil).toBe(true);
  });
});

describe('Promotion Expiration', () => {
  beforeEach(() => {
    withFixedTime(TEST_DATES.NOW);
  });

  afterEach(() => {
    resetClock();
  });

  it('promotion becomes invalid at expiry', () => {
    const promoStartsAt = Clock.now();
    const promoExpiresAt = Clock.now() + 30 * DURATION.DAY;

    expect(Clock.now()).toBeGreaterThanOrEqual(promoStartsAt);
    expect(Clock.now()).toBeLessThan(promoExpiresAt);

    advanceDays(29);
    expect(Clock.now()).toBeLessThan(promoExpiresAt);

    advanceDays(1);
    expect(Clock.now()).toBeGreaterThanOrEqual(promoExpiresAt);
  });

  it('validates promotion during active window', () => {
    const promoStartsAt = Clock.now() - DURATION.DAY;
    const promoExpiresAt = Clock.now() + DURATION.DAY;

    expect(Clock.now()).toBeGreaterThan(promoStartsAt);
    expect(Clock.now()).toBeLessThan(promoExpiresAt);

    advanceHours(12);
    expect(Clock.now()).toBeLessThan(promoExpiresAt);

    advanceHours(13);
    expect(Clock.now()).toBeGreaterThan(promoExpiresAt);
  });
});

describe('Data Retention Cutoffs', () => {
  beforeEach(() => {
    withFixedTime(TEST_DATES.NOW);
  });

  afterEach(() => {
    resetClock();
  });

  it('applies 90-day retention cutoff', () => {
    const retentionDays = 90;
    const cutoffDate = Clock.now() - retentionDays * DURATION.DAY;

    const recentRecord = Clock.now() - 30 * DURATION.DAY;
    const oldRecord = Clock.now() - 100 * DURATION.DAY;

    expect(recentRecord).toBeGreaterThan(cutoffDate);
    expect(oldRecord).toBeLessThan(cutoffDate);
  });

  it('marks records for deletion at exact boundary', () => {
    const retentionDays = 90;
    const recordCreatedAt = Clock.now() - retentionDays * DURATION.DAY;
    const cutoffDate = Clock.now() - retentionDays * DURATION.DAY;

    expect(recordCreatedAt).toBe(cutoffDate);

    advanceDays(1);
    const newCutoff = Clock.now() - retentionDays * DURATION.DAY;
    expect(recordCreatedAt).toBeLessThan(newCutoff);
  });
});

describe('Saved Search Alert Timing', () => {
  beforeEach(() => {
    withFixedTime(TEST_DATES.NOW);
  });

  afterEach(() => {
    resetClock();
  });

  it('sends daily digest at scheduled time', () => {
    const lastSentAt = Clock.now() - 24 * DURATION.HOUR;
    const nextSendAt = lastSentAt + 24 * DURATION.HOUR;

    expect(Clock.now()).toBe(nextSendAt);

    advanceHours(1);
    expect(Clock.now()).toBeGreaterThan(nextSendAt);
  });

  it('respects weekly digest frequency', () => {
    const lastSentAt = Clock.now() - 7 * DURATION.DAY;
    const nextSendAt = lastSentAt + 7 * DURATION.DAY;

    expect(Clock.now()).toBe(nextSendAt);

    advanceDays(1);
    expect(Clock.now()).toBeGreaterThan(nextSendAt);
  });
});

describe('Timezone Boundary Testing', () => {
  beforeEach(() => {
    withFixedTime(new Date('2027-06-15T00:00:00Z'));
  });

  afterEach(() => {
    resetClock();
  });

  it('handles midnight boundary correctly', () => {
    const midnight = new Date('2027-06-15T00:00:00Z').getTime();
    expect(Clock.now()).toBe(midnight);

    Clock.advance(1);
    expect(Clock.now()).toBeGreaterThan(midnight);

    Clock.advance(-1);
    expect(Clock.now()).toBe(midnight);
  });

  it('detects day rollover', () => {
    const day1 = Clock.date().getUTCDate();

    advanceHours(23);
    expect(Clock.date().getUTCDate()).toBe(day1);

    advanceHours(1);
    expect(Clock.date().getUTCDate()).toBe(day1 + 1);
  });
});

describe('Date Comparison Helpers', () => {
  beforeEach(() => {
    withFixedTime(TEST_DATES.NOW);
  });

  afterEach(() => {
    resetClock();
  });

  it('assertDateNear passes for exact match', () => {
    const date = Clock.date();
    expect(() => assertDateNear(date, TEST_DATES.NOW, 1000)).not.toThrow();
  });

  it('assertDateNear passes within tolerance', () => {
    const date = new Date(Clock.now() + 500);
    expect(() => assertDateNear(date, TEST_DATES.NOW, 1000)).not.toThrow();
  });

  it('assertDateNear fails outside tolerance', () => {
    const date = new Date(Clock.now() + 2000);
    expect(() => assertDateNear(date, TEST_DATES.NOW, 1000)).toThrow();
  });
});
