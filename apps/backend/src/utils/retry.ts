import { supabase } from '../config/supabase.js';
import { connectRedis } from '../config/redis.js';

interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
}

// ─── Fallback defaults (used when env vars are absent or malformed) ────────────
const FALLBACK_MAX_ATTEMPTS = 5;
const FALLBACK_INITIAL_DELAY_MS = 1000;
const FALLBACK_MAX_DELAY_MS = 30000;
const FALLBACK_BACKOFF_MULTIPLIER = 2;

/**
 * Parse an integer from a string, returning `fallback` if the result is not a
 * finite positive integer.  Handles NaN, Infinity, zero, and negatives.
 *
 * Fixes issue #479: zero or negative attempt count from env would skip all
 * retries; malformed values would produce NaN and unpredictable behaviour.
 */
function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

/**
 * Parse a non-negative finite integer (0 is allowed for delay values so the
 * caller can disable waiting).
 */
function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxAttempts: parsePositiveInt(process.env.STARTUP_RETRY_ATTEMPTS, FALLBACK_MAX_ATTEMPTS),
  initialDelayMs: parseNonNegativeInt(process.env.STARTUP_RETRY_INITIAL_DELAY_MS, FALLBACK_INITIAL_DELAY_MS),
  maxDelayMs: parseNonNegativeInt(process.env.STARTUP_RETRY_MAX_DELAY_MS, FALLBACK_MAX_DELAY_MS),
  backoffMultiplier: FALLBACK_BACKOFF_MULTIPLIER,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compute the next backoff delay in milliseconds.
 *
 * Uses safe arithmetic to prevent the exponential calculation from producing
 * `Infinity` or `NaN` before `Math.min` is applied (issue #480).  When the
 * intermediate result overflows to a non-finite number it is clamped directly
 * to `maxDelayMs`, so no retry delay can ever be infinite or negative.
 */
export function calculateNextDelay(attempt: number, options: Required<RetryOptions>): number {
  const exponentialDelay = options.initialDelayMs * Math.pow(options.backoffMultiplier, attempt);
  // Guard against Infinity / NaN produced by large attempt counts or multipliers.
  const safeDelay = Number.isFinite(exponentialDelay) ? exponentialDelay : options.maxDelayMs;
  return Math.min(safeDelay, options.maxDelayMs);
}

async function probeSupabase(): Promise<boolean> {
  const { error } = await supabase
    .from('properties')
    .select('id', { count: 'exact', head: true });
  return !error;
}

async function probeRedis(): Promise<boolean> {
  try {
    await connectRedis();
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalize caller-supplied options so that invalid values (zero, negative,
 * NaN, Infinity) fall back to the configured defaults (issue #479).
 */
function normalizeOptions(options: RetryOptions): Required<RetryOptions> {
  const base = DEFAULT_RETRY_OPTIONS;
  return {
    maxAttempts:
      options.maxAttempts !== undefined
        ? (Number.isFinite(options.maxAttempts) && options.maxAttempts >= 1
            ? Math.floor(options.maxAttempts)
            : base.maxAttempts)
        : base.maxAttempts,
    initialDelayMs:
      options.initialDelayMs !== undefined
        ? (Number.isFinite(options.initialDelayMs) && options.initialDelayMs >= 0
            ? Math.floor(options.initialDelayMs)
            : base.initialDelayMs)
        : base.initialDelayMs,
    maxDelayMs:
      options.maxDelayMs !== undefined
        ? (Number.isFinite(options.maxDelayMs) && options.maxDelayMs >= 0
            ? Math.floor(options.maxDelayMs)
            : base.maxDelayMs)
        : base.maxDelayMs,
    backoffMultiplier:
      options.backoffMultiplier !== undefined
        ? (Number.isFinite(options.backoffMultiplier) && options.backoffMultiplier > 0
            ? options.backoffMultiplier
            : base.backoffMultiplier)
        : base.backoffMultiplier,
  };
}

export async function retryDependencyConnections(
  options: RetryOptions = {}
): Promise<void> {
  const config: Required<RetryOptions> = normalizeOptions(options);
  let attempt = 0;

  while (attempt < config.maxAttempts) {
    attempt++;
    console.log(
      `[Startup] Checking dependencies (attempt ${attempt}/${config.maxAttempts})...`
    );

    try {
      const supabaseOk = await probeSupabase();
      const redisOk = await probeRedis();

      if (supabaseOk && redisOk) {
        console.log('[Startup] All dependencies are reachable ✓');
        return;
      }

      const failedDeps = [];
      if (!supabaseOk) failedDeps.push('Supabase');
      if (!redisOk) failedDeps.push('Redis');

      console.warn(`[Startup] Unreachable: ${failedDeps.join(', ')}`);
    } catch (error) {
      console.error(
        `[Startup] Dependency check failed:`,
        error instanceof Error ? error.message : String(error)
      );
    }

    if (attempt >= config.maxAttempts) {
      console.error(
        `[Startup] Failed to connect to dependencies after ${config.maxAttempts} attempts. Exiting.`
      );
      process.exit(1);
    }

    const delay = calculateNextDelay(attempt - 1, config);
    console.log(`[Startup] Retrying in ${delay}ms...`);
    await sleep(delay);
  }
}
