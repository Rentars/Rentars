import { createClient } from 'redis';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

/**
 * Key prefix for all rate-limit related keys. Kept consistent across
 * instances so shared counters are visible to every backend node.
 */
export const RATE_LIMIT_KEY_PREFIX = process.env.REDIS_KEY_PREFIX
  ? `${process.env.REDIS_KEY_PREFIX}:rl:`
  : 'rl:';

export const redisClient = createClient({
  url: redisUrl,
  // Retry with capped exponential backoff so a transient Redis outage does not
  // permanently break a node in a multi-instance deployment.
  socket: {
    reconnectStrategy: (retries: number) => {
      if (retries > 20) {
        console.error('[redis] Max reconnect attempts reached');
        return new Error('Redis reconnect attempts exhausted');
      }
      return Math.min(retries * 100, 3000);
    },
    connectTimeout: 5000,
  },
});

redisClient.on('error', (err) => console.error('[redis] Client error:', err));
redisClient.on('connect', () => console.log('[redis] Connected'));
redisClient.on('reconnecting', () => console.log('[redis] Reconnecting...'));

let connected = false;

export async function connectRedis(): Promise<void> {
  if (connected) return;
  await redisClient.connect();
  connected = true;
}

const REDIS_PING_TIMEOUT_MS = 1500;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Redis operation timed out')), ms);
    }),
  ]);
}

/**
 * Verify Redis connectivity with a bounded-time PING.
 *
 * @returns true if Redis replies with PONG within the timeout, false otherwise
 */
export async function pingRedis(): Promise<boolean> {
  try {
    await withTimeout(connectRedis(), REDIS_PING_TIMEOUT_MS);
    const reply = await withTimeout(redisClient.ping(), REDIS_PING_TIMEOUT_MS);
    return reply === 'PONG';
  } catch {
    return false;
  }
}

/**
 * Lua script that atomically increments a counter and (re)applies a TTL on the
 * first increment. Returns the current count and the remaining TTL in ms so
 * callers can compute a safe retry interval.
 *
 * KEYS[1] = counter key
 * ARGV[1] = window length in milliseconds
 */
const INCR_WITH_EXPIRE_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return { current, ttl }
`;

const REDIS_OP_TIMEOUT_MS = 1000;

export interface CounterResult {
  /** Current count after increment. */
  count: number;
  /** Remaining time-to-live of the counter window in milliseconds. */
  ttlMs: number;
}

/**
 * Atomically increment a shared counter and ensure it expires.
 *
 * Uses a Lua script so INCR + PEXPIRE happen atomically, guaranteeing that all
 * backend instances observe the same counter value and window. The key is
 * automatically namespaced with {@link RATE_LIMIT_KEY_PREFIX}.
 *
 * @param key   Logical counter key (e.g. `login:user:123`)
 * @param windowMs Window length in milliseconds applied on first increment
 * @returns The incremented count and remaining TTL, or null if Redis is unavailable
 */
export async function incrementRateLimitCounter(
  key: string,
  windowMs: number,
): Promise<CounterResult | null> {
  const fullKey = `${RATE_LIMIT_KEY_PREFIX}${key}`;
  try {
    await withTimeout(connectRedis(), REDIS_OP_TIMEOUT_MS);
    const result = (await withTimeout(
      redisClient.eval(INCR_WITH_EXPIRE_SCRIPT, {
        keys: [fullKey],
        arguments: [String(windowMs)],
      }),
      REDIS_OP_TIMEOUT_MS,
    )) as [number, number];

    const count = Number(result[0]);
    let ttlMs = Number(result[1]);
    // PTTL returns -1 if no expiry was set (should not happen) and -2 if the
    // key vanished; fall back to the full window in either case.
    if (!Number.isFinite(ttlMs) || ttlMs < 0) {
      ttlMs = windowMs;
    }
    return { count, ttlMs };
  } catch (err) {
    console.error('[redis] incrementRateLimitCounter failed:', err);
    return null;
  }
}

/**
 * Read the current counter value without incrementing it.
 *
 * @param key Logical counter key (prefix is applied automatically)
 * @returns The current count and remaining TTL, or null if unavailable
 */
export async function getRateLimitCounter(
  key: string,
): Promise<CounterResult | null> {
  const fullKey = `${RATE_LIMIT_KEY_PREFIX}${key}`;
  try {
    await withTimeout(connectRedis(), REDIS_OP_TIMEOUT_MS);
    const [countRaw, ttlRaw] = (await withTimeout(
      redisClient.multi().get(fullKey).pttl(fullKey).exec(),
      REDIS_OP_TIMEOUT_MS,
    )) as [string | null, number];

    const count = countRaw ? Number(countRaw) : 0;
    let ttlMs = Number(ttlRaw);
    if (!Number.isFinite(ttlMs) || ttlMs < 0) {
      ttlMs = 0;
    }
    return { count, ttlMs };
  } catch (err) {
    console.error('[redis] getRateLimitCounter failed:', err);
    return null;
  }
}

/**
 * Reset a counter (primarily for tests and administrative tooling).
 *
 * @param key Logical counter key (prefix is applied automatically)
 */
export async function resetRateLimitCounter(key: string): Promise<void> {
  const fullKey = `${RATE_LIMIT_KEY_PREFIX}${key}`;
  try {
    await withTimeout(connectRedis(), REDIS_OP_TIMEOUT_MS);
    await withTimeout(redisClient.del(fullKey), REDIS_OP_TIMEOUT_MS);
  } catch (err) {
    console.error('[redis] resetRateLimitCounter failed:', err);
  }
}