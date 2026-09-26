/**
 * Redis client configuration.
 *
 * Provides a single shared node-redis v6 client with:
 *   - Environment-scoped key namespace so dev/staging/production keys
 *     can never collide on a shared Redis instance.
 *   - Connection retry with exponential back-off (capped at 30 s).
 *   - Structured error / event logging via structuredLog.
 *   - A bounded-time pingRedis() health check.
 *   - Exported REDIS_NAMESPACE used by cache.service.ts to prefix every key.
 */

import { createClient } from 'redis';
import { env } from './env.js';

// ── Key namespace ─────────────────────────────────────────────────────────────

/**
 * Every Redis key written by this application is prefixed with
 * `rentars:<environment>:` so that:
 *   - dev / staging / production never share key space on a shared broker.
 *   - A wildcard FLUSH of `rentars:development:*` is safe in local dev.
 *
 * Service-specific cache prefixes further scope keys:
 *   e.g.  rentars:production:cache:property:<id>
 *         rentars:production:rl:general:<ip>
 *         rentars:production:session:<token>
 */
export const REDIS_NAMESPACE = `rentars:${env.NODE_ENV}`;

// ── Retry strategy ────────────────────────────────────────────────────────────

const MAX_RETRY_DELAY_MS = 30_000;
const BASE_RETRY_DELAY_MS = 200;

/**
 * Exponential back-off with jitter, capped at MAX_RETRY_DELAY_MS.
 * Called by node-redis before each reconnect attempt.
 */
function retryStrategy(retries: number): number {
  const delay = Math.min(
    BASE_RETRY_DELAY_MS * 2 ** retries + Math.random() * 100,
    MAX_RETRY_DELAY_MS,
  );
  return delay;
}

// ── Client creation ───────────────────────────────────────────────────────────

export const redisClient = createClient({
  url: env.REDIS_URL ?? 'redis://localhost:6379',
  socket: {
    reconnectStrategy: retryStrategy,
    connectTimeout: 5_000,
    // Keep connections alive — prevents silent TCP drop on cloud providers.
    keepAlive: 10_000,
  },
});

// ── Event logging ─────────────────────────────────────────────────────────────
// Use lazy import to avoid circular dependency (logging.middleware → env → redis).
// We only need the logger after the process is running, never at module-init time.

function log(level: 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>) {
  // Dynamic import is fine here — events fire after startup.
  import('../middleware/logging.middleware.js').then(({ structuredLog }) => {
    structuredLog({
      level,
      message,
      timestamp: new Date().toISOString(),
      service: 'redis',
      ...extra,
    });
  }).catch(() => {
    // Fallback if logger module fails to load (e.g. early-boot errors)
    console[level](`[redis] ${message}`, extra ?? '');
  });
}

redisClient.on('error',       (err) => log('error', 'Redis client error',      { error: String(err) }));
redisClient.on('connect',     ()    => log('info',  'Redis connected'));
redisClient.on('ready',       ()    => log('info',  'Redis ready'));
redisClient.on('reconnecting',()    => log('warn',  'Redis reconnecting'));
redisClient.on('end',         ()    => log('warn',  'Redis connection closed'));

// ── Connection state ──────────────────────────────────────────────────────────

let connected = false;

export async function connectRedis(): Promise<void> {
  if (connected) return;
  await redisClient.connect();
  connected = true;
}

const REDIS_PING_TIMEOUT_MS = 1_500;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Redis operation timed out')), ms),
    ),
  ]);
}

/**
 * Verify Redis connectivity with a bounded-time PING.
 * Returns true if Redis replies PONG within REDIS_PING_TIMEOUT_MS.
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
