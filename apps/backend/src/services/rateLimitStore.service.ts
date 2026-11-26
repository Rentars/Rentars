/**
 * Rate-limit rejection store.
 *
 * Records every rate-limit rejection with route, method, scope, hashed identity,
 * and a Unix timestamp.  Provides aggregated summary queries by route and time window.
 *
 * Storage strategy:
 * - With Redis: sorted sets keyed by scope+route for O(log N) range queries.
 * - Without Redis (in-memory fallback): a capped ring buffer per key.
 *
 * Privacy: raw IPs / userIds must be hashed BEFORE calling record().
 * The store never has access to un-hashed identities.
 */

import { redisClient } from '@/config/redis.js';
import { redisKeys } from '@/config/redisKeys.js';

export interface RejectionRecord {
  route: string;
  method: string;
  scope: string;
  hashedIdentity: string;
  timestamp: number; // Unix ms
  /** Resolved identity class (e.g. 'user', 'anon', 'ip'). */
  identityClass?: string;
  /** Endpoint class / budget name (e.g. 'login', 'search', 'upload'). */
  endpointClass?: string;
}

export interface RouteStats {
  route: string;
  method: string;
  scope: string;
  count: number;
}

export interface SummaryWindow {
  windowSeconds: number;
  since: string; // ISO timestamp
  byRoute: RouteStats[];
  total: number;
}

/** Maximum age of records kept in Redis sorted sets (7 days in seconds). */
const MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

// ── In-memory fallback ────────────────────────────────────────────────────────

interface InMemoryBucket {
  records: RejectionRecord[];
}

const inMemoryStore = new Map<string, InMemoryBucket>();
/** Cap per route bucket to avoid unbounded growth. */
const MAX_IN_MEMORY_PER_KEY = 10_000;

// ─────────────────────────────────────────────────────────────────────────────

class RateLimitStoreService {
  private get useRedis(): boolean {
    return !!process.env.REDIS_URL;
  }

  /**
   * Record a single rate-limit rejection.
   * Called from the rate limiter middleware — must not throw.
   */
  async record(entry: RejectionRecord): Promise<void> {
    try {
      if (this.useRedis) {
        await this.recordRedis(entry);
      } else {
        this.recordMemory(entry);
      }
    } catch (err) {
      // Never crash the middleware — log and continue
      console.error('[RateLimitStore] record error:', err);
    }
  }

  /**
   * Return an aggregated summary of rejections over the given time window.
   * Results are sorted by count descending (hottest routes first).
   */
  async getSummary(windowSeconds = 3600): Promise<SummaryWindow> {
    try {
      if (this.useRedis) {
        return await this.getSummaryRedis(windowSeconds);
      }
      return this.getSummaryMemory(windowSeconds);
    } catch (err) {
      console.error('[RateLimitStore] getSummary error:', err);
      return {
        windowSeconds,
        since: new Date(Date.now() - windowSeconds * 1000).toISOString(),
        byRoute: [],
        total: 0,
      };
    }
  }

  // ── Redis implementation ────────────────────────────────────────────────────

  private redisKey(scope: string, route: string, method: string): string {
    // Delegate to the shared key namespace so every instance agrees on key names.
    return redisKeys.rateLimitReject(scope, method, route);
  }

  private async recordRedis(entry: RejectionRecord): Promise<void> {
    const key = this.redisKey(entry.scope, entry.route, entry.method);
    const score = entry.timestamp;
    // Store as JSON member in a sorted set scored by timestamp
    const member = JSON.stringify({
      id: entry.hashedIdentity,
      ts: entry.timestamp,
      ic: entry.identityClass,
      ec: entry.endpointClass,
    });

    // Use a MULTI transaction so the add + trim + TTL are applied atomically
    // and consistently across all backend instances sharing this Redis.
    const cutoff = Date.now() - MAX_AGE_SECONDS * 1000;
    await redisClient
      .multi()
      .zAdd(key, { score, value: member })
      .zRemRangeByScore(key, 0, cutoff)
      .expire(key, MAX_AGE_SECONDS)
      .exec();
  }

  /**
   * Record a rejection using the resolved identity class and endpoint class.
   * Convenience wrapper around record() for callers that have already resolved
   * the identity (authenticated user vs anonymous) and the endpoint budget.
   */
  async recordRejection(params: {
    route: string;
    method: string;
    scope: string;
    hashedIdentity: string;
    identityClass?: string;
    endpointClass?: string;
    timestamp?: number;
  }): Promise<void> {
    await this.record({
      route: params.route,
      method: params.method,
      scope: params.scope,
      hashedIdentity: params.hashedIdentity,
      identityClass: params.identityClass,
      endpointClass: params.endpointClass,
      timestamp: params.timestamp ?? Date.now(),
    });
  }

  private async getSummaryRedis(windowSeconds: number): Promise<SummaryWindow> {
    const since = Date.now() - windowSeconds * 1000;
    const pattern = redisKeys.rateLimitRejectPattern();

    const keys: string[] = [];
    let cursor = 0;
    do {
      const reply = await redisClient.scan(cursor, { MATCH: pattern, COUNT: 200 });
      cursor = reply.cursor;
      keys.push(...reply.keys);
    } while (cursor !== 0);

    const byRoute: RouteStats[] = [];
    let total = 0;

    for (const key of keys) {
      const count = await redisClient.zCount(key, since, '+inf');
      if (count === 0) continue;

      // Parse scope, method, route from the shared key namespace.
      const parsed = redisKeys.parseRateLimitRejectKey(key);
      if (!parsed) continue;
      const { scope, method, route } = parsed;

      byRoute.push({ route, method, scope, count });
      total += count;
    }

    byRoute.sort((a, b) => b.count - a.count);

    return {
      windowSeconds,
      since: new Date(since).toISOString(),
      byRoute,
      total,
    };
  }

  // ── In-memory implementation ────────────────────────────────────────────────

  private bucketKey(entry: RejectionRecord): string {
    return `${entry.scope}:${entry.method}:${entry.route}`;
  }

  private recordMemory(entry: RejectionRecord): void {
    const key = this.bucketKey(entry);
    let bucket = inMemoryStore.get(key);
    if (!bucket) {
      bucket = { records: [] };
      inMemoryStore.set(key, bucket);
    }
    bucket.records.push(entry);
    // Cap to avoid unbounded growth
    if (bucket.records.length > MAX_IN_MEMORY_PER_KEY) {
      bucket.records.splice(0, bucket.records.length - MAX_IN_MEMORY_PER_KEY);
    }
  }

  private getSummaryMemory(windowSeconds: number): SummaryWindow {
    const since = Date.now() - windowSeconds * 1000;
    const byRoute: RouteStats[] = [];
    let total = 0;

    for (const [key, bucket] of inMemoryStore.entries()) {
      const count = bucket.records.filter((r) => r.timestamp >= since).length;
      if (count === 0) continue;

      const [scope, method, ...routeParts] = key.split(':');
      const route = routeParts.join(':');
      byRoute.push({ route, method, scope, count });
      total += count;
    }

    byRoute.sort((a, b) => b.count - a.count);

    return {
      windowSeconds,
      since: new Date(since).toISOString(),
      byRoute,
      total,
    };
  }

  /** Exposed for testing — clears the in-memory store. */
  _clearMemoryStore(): void {
    inMemoryStore.clear();
  }

  /** Exposed for testing — returns the shared Redis key for a rejection bucket. */
  _redisKey(scope: string, route: string, method: string): string {
    return this.redisKey(scope, route, method);
  }
}

export const rateLimitStore = new RateLimitStoreService();
