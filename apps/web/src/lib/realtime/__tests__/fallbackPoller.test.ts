/**
 * Unit tests for the graceful-degradation poller (issue #646).
 *
 * The poller is the safety net when the socket can never come back, so the
 * properties that matter are: it never overlaps ticks, it backs off on
 * failure, it gives up after a bounded number of attempts, and it stops
 * cleanly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_POLL_INTERVAL_MS, createFallbackPoller } from '../fallbackPoller';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Let queued microtasks drain so an async tick can settle. */
async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}

describe('createFallbackPoller — lifecycle', () => {
  it('does not tick until started', async () => {
    const tick = vi.fn();
    const poller = createFallbackPoller({ tick, intervalMs: 1_000 });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(tick).not.toHaveBeenCalled();
  });

  it('ticks promptly on start', async () => {
    const tick = vi.fn();
    const poller = createFallbackPoller({ tick, intervalMs: 1_000 });

    poller.start();
    await settle();

    expect(tick).toHaveBeenCalledTimes(1);
    expect(poller.isRunning()).toBe(true);
  });

  it('is idempotent — a second start does not double-schedule', async () => {
    const tick = vi.fn();
    const poller = createFallbackPoller({ tick, intervalMs: 1_000 });

    poller.start();
    poller.start();
    await settle();

    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('stops ticking after stop()', async () => {
    const tick = vi.fn();
    const poller = createFallbackPoller({ tick, intervalMs: 1_000 });

    poller.start();
    await settle();
    poller.stop();
    tick.mockClear();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(tick).not.toHaveBeenCalled();
    expect(poller.isRunning()).toBe(false);
  });

  it('can be restarted after stopping', async () => {
    const tick = vi.fn();
    const poller = createFallbackPoller({ tick, intervalMs: 1_000 });

    poller.start();
    await settle();
    poller.stop();
    poller.start();
    await settle();

    expect(tick).toHaveBeenCalledTimes(2);
  });
});

describe('createFallbackPoller — steady-state cadence', () => {
  it('re-polls on the configured interval after a success', async () => {
    const tick = vi.fn().mockResolvedValue(undefined);
    const poller = createFallbackPoller({ tick, intervalMs: 5_000 });

    poller.start();
    await settle();
    expect(tick).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(tick).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it('uses a 15 s default interval', () => {
    expect(DEFAULT_POLL_INTERVAL_MS).toBe(15_000);
  });

  it('resets the failure counter after a success', async () => {
    let shouldFail = true;
    const tick = vi.fn().mockImplementation(async () => {
      if (shouldFail) throw new Error('down');
    });
    const onError = vi.fn();
    const poller = createFallbackPoller({
      tick,
      intervalMs: 1_000,
      maxAttempts: 10,
      onError,
      backoff: { random: () => 0.5 },
    });

    poller.start();
    await settle();
    expect(tick).toHaveBeenCalledTimes(1);
    expect(poller.attemptCount()).toBe(1);

    shouldFail = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(poller.attemptCount()).toBe(0);
  });

  it('calls onSuccess after each successful tick', async () => {
    const onSuccess = vi.fn();
    const poller = createFallbackPoller({
      tick: vi.fn().mockResolvedValue(undefined),
      intervalMs: 1_000,
      onSuccess,
    });

    poller.start();
    await settle();

    expect(onSuccess).toHaveBeenCalledTimes(1);
  });
});

describe('createFallbackPoller — no overlapping ticks', () => {
  it('waits for a slow tick to settle before scheduling the next', async () => {
    let resolveTick: (() => void) | undefined;
    let started = 0;

    const tick = vi.fn().mockImplementation(async () => {
      started += 1;
      await new Promise<void>((resolve) => {
        resolveTick = resolve;
      });
    });

    const poller = createFallbackPoller({ tick, intervalMs: 1_000 });
    poller.start();
    await settle();

    // Elapse many intervals while the first tick is still in flight.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(started).toBe(1);

    resolveTick?.();
    await settle();

    // Only now does the next one get scheduled.
    expect(started).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(started).toBe(2);
  });

  it('supports a synchronous tick implementation', async () => {
    const tick = vi.fn();
    const poller = createFallbackPoller({ tick, intervalMs: 1_000 });

    poller.start();
    await vi.advanceTimersByTimeAsync(3_500);

    expect(tick).toHaveBeenCalledTimes(4);
  });
});

describe('createFallbackPoller — failure backoff', () => {
  it('backs off longer after each consecutive failure', async () => {
    const tick = vi.fn().mockRejectedValue(new Error('down'));
    const poller = createFallbackPoller({
      tick,
      intervalMs: 1_000,
      maxAttempts: 5,
      backoff: { random: () => 0.5, jitterRatio: 0 },
    });

    poller.start();
    await settle();
    expect(tick).toHaveBeenCalledTimes(1);

    // First backoff = 1_000 * 2^0 = 1_000 ms
    await vi.advanceTimersByTimeAsync(999);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(2);

    // Second backoff = 1_000 * 2^1 = 2_000 ms
    await vi.advanceTimersByTimeAsync(1_999);
    expect(tick).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it('reports the attempt number on each failure', async () => {
    const onError = vi.fn();
    const poller = createFallbackPoller({
      tick: vi.fn().mockRejectedValue(new Error('down')),
      intervalMs: 1_000,
      maxAttempts: 3,
      onError,
      backoff: { random: () => 0.5 },
    });

    poller.start();
    await settle();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 1);
  });

  it('never exceeds maxIntervalMs even under sustained failure', async () => {
    const tick = vi.fn().mockRejectedValue(new Error('down'));
    const poller = createFallbackPoller({
      tick,
      intervalMs: 1_000,
      maxIntervalMs: 5_000,
      maxAttempts: 50,
      backoff: { random: () => 1, jitterRatio: 0.5 },
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(300_000);

    // A 5-minute window cannot hold more than ~60 polls at a 5 s ceiling.
    expect(tick.mock.calls.length).toBeLessThanOrEqual(60);
  });
});

describe('createFallbackPoller — exhaustion', () => {
  it('stops after maxAttempts and fires onExhausted once', async () => {
    const tick = vi.fn().mockRejectedValue(new Error('down'));
    const onExhausted = vi.fn();
    const poller = createFallbackPoller({
      tick,
      intervalMs: 1_000,
      maxAttempts: 3,
      onExhausted,
      backoff: { random: () => 0.5, jitterRatio: 0 },
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(tick).toHaveBeenCalledTimes(3);
    expect(onExhausted).toHaveBeenCalledTimes(1);
    expect(poller.isRunning()).toBe(false);
  });

  it('does not keep polling after exhaustion', async () => {
    const tick = vi.fn().mockRejectedValue(new Error('down'));
    const poller = createFallbackPoller({
      tick,
      intervalMs: 1_000,
      maxAttempts: 2,
      backoff: { random: () => 0.5 },
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(120_000);
    const callsAtExhaustion = tick.mock.calls.length;

    await vi.advanceTimersByTimeAsync(120_000);
    expect(tick).toHaveBeenCalledTimes(callsAtExhaustion);
  });

  it('can be restarted after exhaustion', async () => {
    let failing = true;
    const tick = vi.fn().mockImplementation(async () => {
      if (failing) throw new Error('down');
    });
    const poller = createFallbackPoller({
      tick,
      intervalMs: 1_000,
      maxAttempts: 1,
      backoff: { random: () => 0.5 },
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(poller.isRunning()).toBe(false);

    failing = false;
    poller.start();
    await settle();
    expect(poller.isRunning()).toBe(true);
  });

  it('exhausts immediately when maxAttempts is 1', async () => {
    const onExhausted = vi.fn();
    const poller = createFallbackPoller({
      tick: vi.fn().mockRejectedValue(new Error('down')),
      intervalMs: 1_000,
      maxAttempts: 1,
      onExhausted,
    });

    poller.start();
    await settle();

    expect(onExhausted).toHaveBeenCalledTimes(1);
  });
});

describe('createFallbackPoller — poke', () => {
  it('runs the next tick immediately', async () => {
    const tick = vi.fn().mockResolvedValue(undefined);
    const poller = createFallbackPoller({ tick, intervalMs: 60_000 });

    poller.start();
    await settle();
    expect(tick).toHaveBeenCalledTimes(1);

    poller.poke();
    await settle();
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('does nothing when the poller is not running', async () => {
    const tick = vi.fn();
    const poller = createFallbackPoller({ tick, intervalMs: 1_000 });

    poller.poke();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(tick).not.toHaveBeenCalled();
  });

  it('does not stack ticks when poked repeatedly', async () => {
    const tick = vi.fn().mockResolvedValue(undefined);
    const poller = createFallbackPoller({ tick, intervalMs: 60_000 });

    poller.start();
    await settle();
    tick.mockClear();

    poller.poke();
    poller.poke();
    poller.poke();
    await settle();

    expect(tick).toHaveBeenCalledTimes(1);
  });
});
