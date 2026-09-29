/**
 * Unit tests for the reconnect backoff curve (issue #646).
 *
 * Covers the three properties the recovery design depends on:
 *  - exponential growth with jitter
 *  - a hard ceiling on delay
 *  - a hard cap on attempts (no infinite retry loop)
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_BACKOFF_OPTIONS,
  NO_RETRY,
  calculateBackoffDelay,
  canRetry,
  remainingAttempts,
} from '../backoff';

afterEach(() => vi.restoreAllMocks());

describe('calculateBackoffDelay — exponential growth', () => {
  it('grows exponentially from the base delay', () => {
    // random() = 0.5 → jitter multiplier (0.5*2-1) = 0 → no jitter
    const opts = { random: () => 0.5, jitterRatio: 0.25 };
    expect(calculateBackoffDelay(0, opts)).toBe(1_000);
    expect(calculateBackoffDelay(1, opts)).toBe(2_000);
    expect(calculateBackoffDelay(2, opts)).toBe(4_000);
    expect(calculateBackoffDelay(3, opts)).toBe(8_000);
  });

  it('doubles per attempt by default', () => {
    const noJitter = { random: () => 0.5, jitterRatio: 0 };
    const d0 = calculateBackoffDelay(0, noJitter);
    const d1 = calculateBackoffDelay(1, noJitter);
    const d2 = calculateBackoffDelay(2, noJitter);
    expect(d1 / d0).toBe(2);
    expect(d2 / d1).toBe(2);
  });

  it('is monotonically non-decreasing across the whole retry range', () => {
    const opts = { random: () => 0.5, maxAttempts: 20 };
    let prev = -1;
    for (let i = 0; i < 19; i += 1) {
      const d = calculateBackoffDelay(i, opts);
      expect(d).toBeGreaterThanOrEqual(prev);
      prev = d;
    }
  });

  it('treats a negative attempt as zero rather than a huge delay', () => {
    expect(calculateBackoffDelay(-5)).toBe(0);
    expect(calculateBackoffDelay(Number.NaN)).toBe(0);
  });
});

describe('calculateBackoffDelay — jitter', () => {
  it('stays within ±jitterRatio of the un-jittered delay', () => {
    const base = 4_000;
    const jitterRatio = 0.25;

    // random() = 0 → -25 %
    expect(calculateBackoffDelay(2, { random: () => 0 })).toBe(base * (1 - jitterRatio));
    // random() = 1 → +25 %
    expect(calculateBackoffDelay(2, { random: () => 1 })).toBe(base * (1 + jitterRatio));
    // random() = 0.5 → no jitter
    expect(calculateBackoffDelay(2, { random: () => 0.5 })).toBe(base);
  });

  it('spreads delays out so concurrent clients do not stampede', () => {
    const delays = new Set<number>();
    for (let i = 0; i < 200; i += 1) {
      delays.add(calculateBackoffDelay(3));
    }
    // Without jitter every client would compute the identical delay.
    expect(delays.size).toBeGreaterThan(50);
  });

  it('never returns a negative delay', () => {
    for (let i = 0; i < 500; i += 1) {
      expect(calculateBackoffDelay(4)).toBeGreaterThanOrEqual(0);
    }
  });

  it('produces exactly the base delay when jitterRatio is 0', () => {
    expect(calculateBackoffDelay(3, { jitterRatio: 0 })).toBe(8_000);
  });

  it('uses Math.random by default', () => {
    const spy = vi.spyOn(Math, 'random');
    calculateBackoffDelay(0);
    expect(spy).toHaveBeenCalled();
  });
});

describe('calculateBackoffDelay — ceiling', () => {
  it('never exceeds maxDelayMs, even with maximum positive jitter', () => {
    const opts = { maxDelayMs: 30_000, random: () => 1, jitterRatio: 0.5, maxAttempts: 50 };
    for (let i = 0; i < 50; i += 1) {
      expect(calculateBackoffDelay(i, opts)).toBeLessThanOrEqual(30_000);
    }
  });

  it('caps a very large attempt at maxDelayMs rather than overflowing', () => {
    // Attempt 7 is the last permitted one under the default cap of 8.
    const d = calculateBackoffDelay(7, { random: () => 0.5 });
    expect(d).toBe(30_000);
  });

  it('stays finite for absurd attempts', () => {
    const d = calculateBackoffDelay(1_000_000, {
      maxAttempts: 2_000_000,
      random: () => 0.5,
    });
    expect(Number.isFinite(d)).toBe(true);
    expect(d).toBe(30_000);
  });

  it('latches rather than overflowing when the attempt reaches the cap', () => {
    expect(calculateBackoffDelay(Number.MAX_SAFE_INTEGER)).toBe(NO_RETRY);
  });
});

describe('calculateBackoffDelay — retry cap', () => {
  it('returns NO_RETRY once the attempt cap is reached', () => {
    const opts = { maxAttempts: 3 };
    expect(calculateBackoffDelay(0, opts)).toBeGreaterThan(0);
    expect(calculateBackoffDelay(1, opts)).toBeGreaterThan(0);
    expect(calculateBackoffDelay(2, opts)).toBeGreaterThan(0);
    expect(calculateBackoffDelay(3, opts)).toBe(NO_RETRY);
    expect(calculateBackoffDelay(4, opts)).toBe(NO_RETRY);
  });

  it('caps out for a zero-attempt budget', () => {
    expect(calculateBackoffDelay(0, { maxAttempts: 0 })).toBe(NO_RETRY);
  });

  it('defaults to 8 attempts', () => {
    expect(DEFAULT_BACKOFF_OPTIONS.maxAttempts).toBe(8);
    expect(calculateBackoffDelay(7)).toBeGreaterThan(0);
    expect(calculateBackoffDelay(8)).toBe(NO_RETRY);
  });
});

describe('calculateBackoffDelay — invalid options', () => {
  it('falls back to safe defaults for non-finite values', () => {
    // `random` is pinned so the assertion is about the sanitised base delay,
    // not about jitter.
    const noJitter = { random: () => 0.5 };
    expect(calculateBackoffDelay(0, { ...noJitter, baseDelayMs: Number.NaN })).toBe(1_000);
    // maxDelayMs falls back to the 30 s default, which is above the 1 s base.
    expect(calculateBackoffDelay(0, { ...noJitter, maxDelayMs: -5 })).toBe(1_000);
    expect(calculateBackoffDelay(0, { ...noJitter, multiplier: 0 })).toBe(1_000);
  });

  it('clamps jitterRatio into [0, 1]', () => {
    const low = calculateBackoffDelay(2, { jitterRatio: -1, random: () => 0 });
    const high = calculateBackoffDelay(2, { jitterRatio: 99, random: () => 0 });
    expect(low).toBe(4_000);
    expect(high).toBe(0);
  });

  it('works with no options argument', () => {
    expect(calculateBackoffDelay(0)).toBeGreaterThan(0);
  });
});

describe('canRetry', () => {
  it('permits retries strictly below the cap', () => {
    expect(canRetry(0, { maxAttempts: 3 })).toBe(true);
    expect(canRetry(2, { maxAttempts: 3 })).toBe(true);
    expect(canRetry(3, { maxAttempts: 3 })).toBe(false);
    expect(canRetry(4, { maxAttempts: 3 })).toBe(false);
  });

  it('rejects negative counts', () => {
    expect(canRetry(-1)).toBe(false);
    expect(canRetry(Number.NaN)).toBe(false);
  });

  it('agrees with calculateBackoffDelay', () => {
    const opts = { maxAttempts: 5 };
    for (let i = 0; i < 10; i += 1) {
      const shouldRetry = canRetry(i, opts);
      const delay = calculateBackoffDelay(i, opts);
      expect(shouldRetry).toBe(delay !== NO_RETRY);
    }
  });
});

describe('remainingAttempts', () => {
  it('counts down to zero and never goes negative', () => {
    expect(remainingAttempts(0, { maxAttempts: 3 })).toBe(3);
    expect(remainingAttempts(2, { maxAttempts: 3 })).toBe(1);
    expect(remainingAttempts(3, { maxAttempts: 3 })).toBe(0);
    expect(remainingAttempts(99, { maxAttempts: 3 })).toBe(0);
  });
});
