/**
 * Rate limit metrics service.
 *
 * Tracks abuse patterns and provides metrics for monitoring and alerting.
 * Uses Redis for storage and supports querying abuse patterns by:
 * - Route and method
 * - Time window
 * - Severity (number of consecutive failures)
 */

import { redisClient } from '@/config/redis.js';
import { createHash } from 'node:crypto';

const METRICS_PREFIX = 'ratelimit:metrics:';
const METRICS_TTL = 60 * 60 * 24; // 24 hours

export interface RateLimitMetric {
  route: string;
  method: string;
  scope: string;
  hashedIdentity: string;
  consecutiveFailures: number;
  firstFailureTime: number;
  lastFailureTime: number;
}

class RateLimitMetricsService {
  /**
   * Record a rate limit event and update failure counters.
   */
  async recordEvent(
    route: string,
    method: string,
    scope: string,
    hashedIdentity: string,
  ): Promise<void> {
    const metricKey = `${METRICS_PREFIX}${scope}:${hashedIdentity}`;

    const existing = await redisClient.get(metricKey);
    const now = Date.now();

    let metric: RateLimitMetric;

    if (existing) {
      try {
        metric = JSON.parse(existing) as RateLimitMetric;
        metric.consecutiveFailures += 1;
        metric.lastFailureTime = now;
      } catch {
        metric = {
          route,
          method,
          scope,
          hashedIdentity,
          consecutiveFailures: 1,
          firstFailureTime: now,
          lastFailureTime: now,
        };
      }
    } else {
      metric = {
        route,
        method,
        scope,
        hashedIdentity,
        consecutiveFailures: 1,
        firstFailureTime: now,
        lastFailureTime: now,
      };
    }

    await redisClient.set(
      metricKey,
      JSON.stringify(metric),
      { EX: METRICS_TTL },
    );
  }

  /**
   * Reset failure counter for an identity (e.g., after successful login).
   */
  async resetFailures(
    scope: string,
    hashedIdentity: string,
  ): Promise<void> {
    const metricKey = `${METRICS_PREFIX}${scope}:${hashedIdentity}`;
    await redisClient.del(metricKey);
  }

  /**
   * Get metric for a specific identity.
   */
  async getMetric(
    scope: string,
    hashedIdentity: string,
  ): Promise<RateLimitMetric | null> {
    const metricKey = `${METRICS_PREFIX}${scope}:${hashedIdentity}`;
    const stored = await redisClient.get(metricKey);

    if (!stored) return null;

    try {
      return JSON.parse(stored) as RateLimitMetric;
    } catch {
      return null;
    }
  }

  /**
   * Query metrics by scope and optional timestamp range.
   * Useful for monitoring and alerting.
   */
  async queryMetrics(
    scope: string,
    options?: {
      minConsecutiveFailures?: number;
      since?: number;
    },
  ): Promise<RateLimitMetric[]> {
    const pattern = `${METRICS_PREFIX}${scope}:*`;
    const metrics: RateLimitMetric[] = [];

    for await (const key of redisClient.scanIterator({ MATCH: pattern, COUNT: 100 })) {
      const stored = await redisClient.get(key);
      if (!stored) continue;

      try {
        const metric = JSON.parse(stored) as RateLimitMetric;

        // Apply filters
        if (options?.minConsecutiveFailures && metric.consecutiveFailures < options.minConsecutiveFailures) {
          continue;
        }

        if (options?.since && metric.lastFailureTime < options.since) {
          continue;
        }

        metrics.push(metric);
      } catch {
        // Skip malformed entries
      }
    }

    return metrics;
  }

  /**
   * Get high-risk identities (severe abuse patterns).
   */
  async getHighRiskIdentities(
    scope: string,
    minConsecutiveFailures: number = 20,
  ): Promise<RateLimitMetric[]> {
    return this.queryMetrics(scope, { minConsecutiveFailures });
  }
}

export const rateLimitMetrics = new RateLimitMetricsService();
