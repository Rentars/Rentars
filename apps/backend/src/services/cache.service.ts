/**
 * Redis cache service — Issue #662: Redis resilience and namespace management.
 *
 * Design decisions
 * ────────────────
 * NAMESPACING
 *   Every key is prefixed with `rentars:<env>:<service>:` so keys from
 *   dev/staging/production never collide, and keys from different services
 *   (cache, session, queue, lock) are visually and operationally distinct.
 *
 * TTL POLICY REGISTRY
 *   All cache uses must go through a named CacheNamespace that declares a
 *   default TTL and a hard maximum TTL.  Callers cannot silently omit a TTL
 *   (which would create immortal keys) or exceed the domain-appropriate ceiling.
 *
 * PAYLOAD SIZE GUARD
 *   Values larger than MAX_PAYLOAD_BYTES are rejected at write time to prevent
 *   one large object from consuming unbounded Redis memory.
 *
 * CIRCUIT BREAKER
 *   After CIRCUIT_OPEN_THRESHOLD consecutive Redis errors within
 *   CIRCUIT_WINDOW_MS the circuit opens.  While open, every cache operation
 *   is a no-op and the application continues serving from the source of truth.
 *   The circuit half-opens after CIRCUIT_RESET_MS to probe Redis health.
 *
 * HIT / MISS / ERROR INSTRUMENTATION
 *   cacheMetrics() returns per-namespace counters for monitoring / alerting.
 *   structuredLog emits cache events so they appear in the aggregation pipeline.
 *
 * KEY INVALIDATION
 *   invalidatePattern uses SCAN (cursor-based) instead of KEYS to avoid
 *   blocking the Redis event loop on large key spaces.
 */

import { connectRedis, redisClient, REDIS_NAMESPACE } from '@/config/redis.js';
import { structuredLog } from '@/middleware/logging.middleware.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum serialised payload size in bytes (512 KB). */
const MAX_PAYLOAD_BYTES = 512 * 1024;

/** Circuit-breaker window in milliseconds. */
const CIRCUIT_WINDOW_MS = 60_000;

/** Number of errors within the window that trips the circuit. */
const CIRCUIT_OPEN_THRESHOLD = 5;

/** How long (ms) to wait before attempting to half-open the circuit. */
const CIRCUIT_RESET_MS = 30_000;

// ── TTL Policy Registry ───────────────────────────────────────────────────────

export interface CacheNamespace {
  /** Human-readable name used as the Redis key segment (no colons). */
  name: string;
  /** Default TTL in seconds when the caller does not specify one. */
  defaultTtlSeconds: number;
  /** Hard ceiling — callers cannot set a TTL above this value. */
  maxTtlSeconds: number;
}

/**
 * Authoritative registry of every cache use in the application.
 *
 * Adding a new cache requires declaring it here with an explicit TTL policy.
 * This prevents immortal keys and documents intended expiry for operators.
 */
export const CACHE_NAMESPACES = {
  // Property listing pages — short TTL so edits appear quickly.
  property:           { name: 'property',           defaultTtlSeconds: 120,   maxTtlSeconds: 600    },
  // Property search results — slightly longer; search is expensive.
  propertySearch:     { name: 'property_search',    defaultTtlSeconds: 60,    maxTtlSeconds: 300    },
  // User profile data — moderate TTL.
  profile:            { name: 'profile',            defaultTtlSeconds: 300,   maxTtlSeconds: 900    },
  // Exchange rates — refresh every 5 min, allow up to 15.
  exchangeRate:       { name: 'exchange_rate',      defaultTtlSeconds: 300,   maxTtlSeconds: 900    },
  // Review aggregates — can tolerate slightly stale data.
  reviews:            { name: 'reviews',            defaultTtlSeconds: 300,   maxTtlSeconds: 1800   },
  // Availability calendars — updated on every booking change.
  availability:       { name: 'availability',       defaultTtlSeconds: 60,    maxTtlSeconds: 300    },
  // Dynamic pricing — recalculated on demand; brief cache.
  dynamicPricing:     { name: 'dynamic_pricing',    defaultTtlSeconds: 60,    maxTtlSeconds: 300    },
  // Session data — long TTL mirrors JWT refresh-token window.
  session:            { name: 'session',            defaultTtlSeconds: 86400, maxTtlSeconds: 604800 },
  // Idempotency keys — kept for 24 h to cover retry windows.
  idempotency:        { name: 'idempotency',        defaultTtlSeconds: 86400, maxTtlSeconds: 86400  },
  // Geolocation / geocoding cache — stable data, long TTL.
  geocoding:          { name: 'geocoding',          defaultTtlSeconds: 3600,  maxTtlSeconds: 86400  },
  // Generic short-lived ephemeral data.
  ephemeral:          { name: 'ephemeral',          defaultTtlSeconds: 30,    maxTtlSeconds: 120    },
} satisfies Record<string, CacheNamespace>;

export type CacheNamespaceKey = keyof typeof CACHE_NAMESPACES;

// ── Metrics ───────────────────────────────────────────────────────────────────

interface NamespaceMetrics {
  hits: number;
  misses: number;
  errors: number;
  payloadRejections: number;
  circuitOpenDrops: number;
}

const metrics = new Map<string, NamespaceMetrics>();

function getMetrics(ns: string): NamespaceMetrics {
  if (!metrics.has(ns)) {
    metrics.set(ns, { hits: 0, misses: 0, errors: 0, payloadRejections: 0, circuitOpenDrops: 0 });
  }
  return metrics.get(ns)!;
}

/** Returns a snapshot of all per-namespace counters for monitoring. */
export function cacheMetrics(): Record<string, NamespaceMetrics> {
  return Object.fromEntries(metrics.entries());
}

// ── Circuit Breaker ───────────────────────────────────────────────────────────

interface CircuitState {
  errors: number;
  windowStart: number;
  openSince: number | null;
}

const circuit: CircuitState = { errors: 0, windowStart: Date.now(), openSince: null };

function isCircuitOpen(): boolean {
  if (circuit.openSince === null) return false;
  // Allow half-open probe after CIRCUIT_RESET_MS
  if (Date.now() - circuit.openSince >= CIRCUIT_RESET_MS) {
    circuit.openSince = null;
    circuit.errors = 0;
    circuit.windowStart = Date.now();
    structuredLog({
      level: 'info',
      message: 'Redis circuit breaker: half-open — probing Redis',
      timestamp: new Date().toISOString(),
      service: 'cache',
    });
    return false;
  }
  return true;
}

function recordCircuitError(): void {
  const now = Date.now();
  // Slide the window
  if (now - circuit.windowStart > CIRCUIT_WINDOW_MS) {
    circuit.errors = 0;
    circuit.windowStart = now;
  }
  circuit.errors += 1;
  if (circuit.errors >= CIRCUIT_OPEN_THRESHOLD && circuit.openSince === null) {
    circuit.openSince = now;
    structuredLog({
      level: 'error',
      message: 'Redis circuit breaker OPEN — cache disabled until probe succeeds',
      timestamp: new Date().toISOString(),
      service: 'cache',
      errorCount: circuit.errors,
      windowMs: CIRCUIT_WINDOW_MS,
    });
  }
}

function recordCircuitSuccess(): void {
  // Reset error count on any successful operation (post-half-open probe passed)
  circuit.errors = 0;
  circuit.openSince = null;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function ensureConnected(): Promise<void> {
  try {
    await connectRedis();
  } catch {
    // Redis unavailable — cache operations will be no-ops
  }
}

/**
 * Build a fully-qualified Redis key.
 *
 * Format: `rentars:<env>:<namespace>:<key>`
 *
 * Example: `rentars:production:property:abc-123`
 */
function buildKey(namespace: CacheNamespace, key: string): string {
  return `${REDIS_NAMESPACE}:${namespace.name}:${key}`;
}

/**
 * Validate and clamp a TTL against the namespace policy.
 * Throws if the value is invalid; clamps silently if it exceeds the maximum.
 */
function resolveTtl(namespace: CacheNamespace, ttlSeconds?: number): number {
  const ttl = ttlSeconds ?? namespace.defaultTtlSeconds;
  if (!Number.isFinite(ttl) || ttl <= 0 || !Number.isInteger(ttl)) {
    throw new Error(
      `cache.set: ttlSeconds must be a finite positive integer, got ${ttl} (namespace: ${namespace.name})`,
    );
  }
  if (ttl > namespace.maxTtlSeconds) {
    structuredLog({
      level: 'warn',
      message: `cache: TTL ${ttl}s exceeds namespace max ${namespace.maxTtlSeconds}s — clamping`,
      timestamp: new Date().toISOString(),
      service: 'cache',
      namespace: namespace.name,
      requestedTtl: ttl,
      clampedTtl: namespace.maxTtlSeconds,
    });
    return namespace.maxTtlSeconds;
  }
  return ttl;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Retrieve a cached value.
 *
 * Returns null on cache miss, Redis unavailability, or circuit-open.
 * The caller should treat null as a miss and fetch from the source of truth.
 *
 * @param namespace - Named TTL policy (use CACHE_NAMESPACES.* constants)
 * @param key       - Application-level key (no namespace prefix needed)
 */
export async function get<T>(namespace: CacheNamespace, key: string): Promise<T | null> {
  const m = getMetrics(namespace.name);

  if (isCircuitOpen()) {
    m.circuitOpenDrops += 1;
    return null;
  }

  const fullKey = buildKey(namespace, key);

  try {
    await ensureConnected();
    const value = await redisClient.get(fullKey);
    if (value === null || value === undefined) {
      m.misses += 1;
      return null;
    }
    m.hits += 1;
    recordCircuitSuccess();
    return JSON.parse(value) as T;
  } catch (err) {
    m.errors += 1;
    recordCircuitError();
    structuredLog({
      level: 'error',
      message: `cache.get error — namespace:${namespace.name} key:${key}`,
      timestamp: new Date().toISOString(),
      service: 'cache',
      namespace: namespace.name,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Store a value in the cache.
 *
 * Rejects payloads larger than MAX_PAYLOAD_BYTES to prevent memory exhaustion.
 * TTL is validated and clamped against the namespace policy.
 *
 * @param namespace  - Named TTL policy
 * @param key        - Application-level key
 * @param value      - JSON-serialisable value
 * @param ttlSeconds - Optional override (must be ≤ namespace.maxTtlSeconds)
 */
export async function set(
  namespace: CacheNamespace,
  key: string,
  value: unknown,
  ttlSeconds?: number,
): Promise<void> {
  const m = getMetrics(namespace.name);

  if (isCircuitOpen()) {
    m.circuitOpenDrops += 1;
    return;
  }

  const ttl = resolveTtl(namespace, ttlSeconds);
  const serialised = JSON.stringify(value);

  // Guard against unbounded memory usage
  if (Buffer.byteLength(serialised, 'utf8') > MAX_PAYLOAD_BYTES) {
    m.payloadRejections += 1;
    structuredLog({
      level: 'warn',
      message: `cache.set: payload exceeds ${MAX_PAYLOAD_BYTES} bytes — write rejected`,
      timestamp: new Date().toISOString(),
      service: 'cache',
      namespace: namespace.name,
      key,
      payloadBytes: Buffer.byteLength(serialised, 'utf8'),
      limitBytes: MAX_PAYLOAD_BYTES,
    });
    return;
  }

  const fullKey = buildKey(namespace, key);

  try {
    await ensureConnected();
    await redisClient.set(fullKey, serialised, { EX: ttl });
    recordCircuitSuccess();
  } catch (err) {
    m.errors += 1;
    recordCircuitError();
    structuredLog({
      level: 'error',
      message: `cache.set error — namespace:${namespace.name} key:${key}`,
      timestamp: new Date().toISOString(),
      service: 'cache',
      namespace: namespace.name,
      error: err instanceof Error ? err.message : String(err),
    });
    // Cache miss is non-fatal — caller continues without cache
  }
}

/**
 * Delete a single key from the cache.
 *
 * @param namespace - Named TTL policy (used for key prefix resolution)
 * @param key       - Application-level key
 */
export async function del(namespace: CacheNamespace, key: string): Promise<void> {
  if (isCircuitOpen()) return;

  const fullKey = buildKey(namespace, key);

  try {
    await ensureConnected();
    await redisClient.del(fullKey);
    recordCircuitSuccess();
  } catch (err) {
    recordCircuitError();
    getMetrics(namespace.name).errors += 1;
    structuredLog({
      level: 'warn',
      message: `cache.del error — namespace:${namespace.name} key:${key}`,
      timestamp: new Date().toISOString(),
      service: 'cache',
      namespace: namespace.name,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Delete all keys matching a glob pattern within a namespace.
 *
 * Uses cursor-based SCAN to avoid blocking the Redis event loop on large
 * key spaces (KEYS is O(N) and blocks all other Redis operations while running).
 *
 * @param namespace - Named TTL policy (determines key prefix)
 * @param pattern   - Glob suffix, e.g. `prop-*` → deletes `rentars:env:namespace:prop-*`
 */
export async function invalidatePattern(namespace: CacheNamespace, pattern: string): Promise<void> {
  if (isCircuitOpen()) return;

  const fullPattern = buildKey(namespace, pattern);

  try {
    await ensureConnected();

    let cursor = 0;
    let totalDeleted = 0;

    do {
      const reply = await redisClient.scan(cursor, { MATCH: fullPattern, COUNT: 200 });
      cursor = reply.cursor;
      const keys = reply.keys;
      if (keys.length > 0) {
        await redisClient.del(keys);
        totalDeleted += keys.length;
      }
    } while (cursor !== 0);

    if (totalDeleted > 0) {
      structuredLog({
        level: 'info',
        message: `cache.invalidatePattern: deleted ${totalDeleted} keys`,
        timestamp: new Date().toISOString(),
        service: 'cache',
        namespace: namespace.name,
        pattern: fullPattern,
        deletedCount: totalDeleted,
      });
    }

    recordCircuitSuccess();
  } catch (err) {
    recordCircuitError();
    getMetrics(namespace.name).errors += 1;
    structuredLog({
      level: 'error',
      message: `cache.invalidatePattern error — namespace:${namespace.name} pattern:${pattern}`,
      timestamp: new Date().toISOString(),
      service: 'cache',
      namespace: namespace.name,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Cache-aside helper: return cached value when present,
 * otherwise call `fetch`, cache the result, and return it.
 *
 * The circuit-open path always falls through to `fetch` — the application
 * continues working without Redis.
 *
 * @param namespace  - Named TTL policy
 * @param key        - Application-level cache key
 * @param fetch      - Async function that loads the canonical value
 * @param ttlSeconds - Optional TTL override
 */
export async function getOrSet<T>(
  namespace: CacheNamespace,
  key: string,
  fetch: () => Promise<T>,
  ttlSeconds?: number,
): Promise<T> {
  const cached = await get<T>(namespace, key);
  if (cached !== null) return cached;

  const value = await fetch();
  // Fire-and-forget: don't let a cache write failure abort the response
  set(namespace, key, value, ttlSeconds).catch(() => undefined);
  return value;
}
