/**
 * Graceful-degradation poller for critical realtime updates (issue #646).
 *
 * When the WebSocket cannot be re-established — bad network, corporate proxy,
 * Supabase Realtime disabled for the project — the app must not go silently
 * stale. `createFallbackPoller` runs a single self-rescheduling timer that
 * calls `tick` and, on repeated failure, backs off with the shared jittered
 * backoff curve. It is intentionally not a plain `setInterval`: overlapping
 * requests after a slow response are a classic source of duplicate toasts.
 *
 * Properties:
 *  - Self-scheduling (next run is scheduled *after* the previous one settles),
 *    so ticks can never overlap.
 *  - Failure backoff uses `calculateBackoffDelay`; success resets the counter.
 *  - Stops cleanly (`stop()`), and `isRunning()` reports the current state.
 */

import { type BackoffOptions, calculateBackoffDelay } from './backoff';

export interface FallbackPollerOptions {
  /** Runs on every tick. Resolving/rejecting drives the backoff. */
  tick: () => Promise<void> | void;
  /** Delay before the first run, in ms. */
  intervalMs: number;
  /** Maximum delay as failures accumulate, in ms. */
  maxIntervalMs?: number;
  /** Consecutive failures tolerated before the poller gives up. */
  maxAttempts?: number;
  /** Backoff tuning; `random` is injectable for deterministic tests. */
  backoff?: Partial<BackoffOptions>;
  /** Called on the transition into the exhausted state. */
  onExhausted?: () => void;
  /** Called after every failed tick, with the 1-based attempt number. */
  onError?: (error: unknown, attempt: number) => void;
  /** Called after every successful tick. */
  onSuccess?: () => void;
}

export interface FallbackPoller {
  start(): void;
  stop(): void;
  isRunning(): boolean;
  /** Force the next tick to happen immediately (e.g. tab regains focus). */
  poke(): void;
  /** Consecutive failures so far. */
  attemptCount(): number;
}

export const DEFAULT_POLL_INTERVAL_MS = 15_000;

export function createFallbackPoller(options: FallbackPollerOptions): FallbackPoller {
  const {
    tick,
    intervalMs,
    maxIntervalMs = 60_000,
    maxAttempts = 5,
    backoff,
    onExhausted,
    onError,
    onSuccess,
  } = options;

  const backoffOptions: Partial<BackoffOptions> = {
    baseDelayMs: intervalMs,
    maxDelayMs: maxIntervalMs,
    multiplier: 2,
    jitterRatio: 0.25,
    maxAttempts,
    ...backoff,
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let attempts = 0;
  let stopped = false;

  const clear = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = (delayMs: number) => {
    if (!running || stopped) return;
    clear();
    timer = setTimeout(run, delayMs);
  };

  const run = async () => {
    if (!running || stopped) return;
    timer = null;

    try {
      await tick();
      attempts = 0;
      onSuccess?.();
      schedule(intervalMs);
    } catch (err) {
      attempts += 1;
      onError?.(err, attempts);

      if (attempts >= maxAttempts) {
        running = false;
        clear();
        onExhausted?.();
        return;
      }

      const delay = calculateBackoffDelay(attempts - 1, backoffOptions);
      schedule(delay < 0 ? maxIntervalMs : delay);
    }
  };

  return {
    start() {
      if (running) return;
      running = true;
      stopped = false;
      attempts = 0;
      schedule(0);
    },
    stop() {
      running = false;
      stopped = true;
      clear();
    },
    isRunning() {
      return running;
    },
    poke() {
      if (!running || stopped) return;
      clear();
      timer = setTimeout(run, 0);
    },
    attemptCount() {
      return attempts;
    },
  };
}
