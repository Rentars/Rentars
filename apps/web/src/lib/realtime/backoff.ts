/**
 * Reconnection backoff utilities (issue #646).
 *
 * Shared by the HTTP client, the realtime channel manager and the fallback
 * poller so every layer retries on the same, predictable schedule.
 *
 * Guarantees:
 *  - Delays grow exponentially (`base * multiplier^attempt`) up to a ceiling.
 *  - Every delay is jittered by ±`jitterRatio` so a fleet of clients that
 *    dropped at the same moment does not stampede the server on recovery.
 *  - Retries are hard-capped by `maxAttempts` so a permanently unreachable
 *    server can never produce an infinite retry loop (server + battery drain).
 *  - `random` is injectable, which keeps the module deterministic under test.
 */

export interface BackoffOptions {
  /** Delay for attempt 0, in milliseconds. */
  baseDelayMs: number;
  /** Upper bound applied after jitter. */
  maxDelayMs: number;
  /** Growth factor per attempt. */
  multiplier: number;
  /** Fraction of the delay used as symmetric jitter (0 disables jitter). */
  jitterRatio: number;
  /** Maximum number of retry attempts before giving up. */
  maxAttempts: number;
  /** Injectable RNG in [0, 1). Defaults to `Math.random`. */
  random: () => number;
}

export const DEFAULT_BACKOFF_OPTIONS: BackoffOptions = {
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  multiplier: 2,
  jitterRatio: 0.25,
  maxAttempts: 8,
  // Resolved lazily so a test that swaps `Math.random` after module load is
  // still honoured.
  random: () => Math.random(),
};

/** Sentinel delay meaning "do not retry". */
export const NO_RETRY = -1;

function sanitize(raw: Partial<BackoffOptions> | undefined): BackoffOptions {
  const merged = { ...DEFAULT_BACKOFF_OPTIONS, ...(raw ?? {}) };
  const positive = (value: number, fallback: number) =>
    Number.isFinite(value) && value > 0 ? value : fallback;

  return {
    baseDelayMs: positive(merged.baseDelayMs, DEFAULT_BACKOFF_OPTIONS.baseDelayMs),
    maxDelayMs: positive(merged.maxDelayMs, DEFAULT_BACKOFF_OPTIONS.maxDelayMs),
    multiplier: positive(merged.multiplier, DEFAULT_BACKOFF_OPTIONS.multiplier),
    jitterRatio: Math.min(Math.max(merged.jitterRatio || 0, 0), 1),
    maxAttempts: Math.max(0, Math.floor(merged.maxAttempts || 0)),
    random: typeof merged.random === 'function' ? merged.random : DEFAULT_BACKOFF_OPTIONS.random,
  };
}

/**
 * Returns the delay in milliseconds to wait before retry number `attempt`
 * (0-based), or `NO_RETRY` when the retry cap has been exhausted.
 *
 * The result is always in `[0, maxDelayMs]`.
 */
export function calculateBackoffDelay(attempt: number, options?: Partial<BackoffOptions>): number {
  const opts = sanitize(options);
  if (!Number.isFinite(attempt) || attempt < 0) return 0;
  if (attempt >= opts.maxAttempts) return NO_RETRY;

  const exponential = opts.baseDelayMs * opts.multiplier ** attempt;
  const capped = Math.min(
    Number.isFinite(exponential) ? exponential : opts.maxDelayMs,
    opts.maxDelayMs
  );

  if (opts.jitterRatio === 0) return Math.max(0, Math.round(capped));

  // Symmetric jitter: capped * (1 ± jitterRatio)
  const jitter = capped * opts.jitterRatio * (opts.random() * 2 - 1);
  return Math.max(0, Math.min(opts.maxDelayMs, Math.round(capped + jitter)));
}

/**
 * Whether another retry is permitted after `attemptsMade` attempts have
 * already been made. Purely a cap check — no delay math.
 */
export function canRetry(attemptsMade: number, options?: Partial<BackoffOptions>): boolean {
  const opts = sanitize(options);
  if (!Number.isFinite(attemptsMade) || attemptsMade < 0) return false;
  return attemptsMade < opts.maxAttempts;
}

/** Number of attempts remaining before the cap is hit. */
export function remainingAttempts(attemptsMade: number, options?: Partial<BackoffOptions>): number {
  const opts = sanitize(options);
  return Math.max(0, opts.maxAttempts - Math.max(0, attemptsMade));
}
