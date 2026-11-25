import type { Request, Response, NextFunction } from 'express';
import { RateLimiterRedis, RateLimiterMemory } from 'rate-limiter-flexible';
import { createHash } from 'node:crypto';
import { redisClient } from '@/config/redis.js';
import { loggingService } from '@/services/logging.service.js';
import { rateLimitStore } from '@/services/rateLimitStore.service.js';
import { rateLimitMetrics } from '@/services/rateLimitMetrics.service.js';
import { redisKeys } from '@/config/redisKeys.js';
import { getClientIp } from '@/utils/trustProxy.js';

export interface AuthRequest extends Request {
  userId?: string;
}

/**
 * Identity class used to scope a rate-limit budget.
 * - `user`: authenticated caller, keyed by user id.
 * - `ip`: anonymous caller, keyed by the validated client IP.
 */
export type IdentityClass = 'user' | 'ip';

/**
 * Endpoint class used to select a rate-limit budget.
 * Each class has its own independent budget so that, e.g., a burst of
 * searches cannot exhaust the login budget.
 */
export type EndpointClass =
  | 'login'
  | 'search'
  | 'upload'
  | 'message'
  | 'expensive'
  | 'general';

export interface RateLimitPolicy {
  /** Endpoint class this policy applies to. */
  endpoint: EndpointClass;
  /** Identity class used to derive the limiter key. */
  identity: IdentityClass;
  /** Maximum number of requests allowed within the window. */
  points: number;
  /** Window length in seconds. */
  durationSeconds: number;
}

/**
 * Default budgets per endpoint class. Anonymous callers get a tighter budget
 * than authenticated users for the same endpoint class.
 */
export const DEFAULT_POLICIES: Record<EndpointClass, { user: RateLimitPolicy; ip: RateLimitPolicy }> = {
  login: {
    user: { endpoint: 'login', identity: 'user', points: 10, durationSeconds: 60 },
    ip: { endpoint: 'login', identity: 'ip', points: 10, durationSeconds: 60 },
  },
  search: {
    user: { endpoint: 'search', identity: 'user', points: 120, durationSeconds: 60 },
    ip: { endpoint: 'search', identity: 'ip', points: 30, durationSeconds: 60 },
  },
  upload: {
    user: { endpoint: 'upload', identity: 'user', points: 20, durationSeconds: 60 },
    ip: { endpoint: 'upload', identity: 'ip', points: 5, durationSeconds: 60 },
  },
  message: {
    user: { endpoint: 'message', identity: 'user', points: 60, durationSeconds: 60 },
    ip: { endpoint: 'message', identity: 'ip', points: 10, durationSeconds: 60 },
  },
  expensive: {
    user: { endpoint: 'expensive', identity: 'user', points: 20, durationSeconds: 60 },
    ip: { endpoint: 'expensive', identity: 'ip', points: 5, durationSeconds: 60 },
  },
  general: {
    user: { endpoint: 'general', identity: 'user', points: 300, durationSeconds: 60 },
    ip: { endpoint: 'general', identity: 'ip', points: 100, durationSeconds: 60 },
  },
};

const useRedis = !!process.env.REDIS_URL;

type Limiter = RateLimiterRedis | RateLimiterMemory;

/**
 * Build a limiter for a policy. Redis key namespacing is centralized in
 * `redisKeys.rateLimit` so every instance (and every endpoint class) shares
 * the same key layout across the fleet.
 */
function buildLimiter(policy: RateLimitPolicy): Limiter {
  const keyPrefix = redisKeys.rateLimit(policy.endpoint, policy.identity);
  if (useRedis) {
    return new RateLimiterRedis({
      storeClient: redisClient,
      keyPrefix,
      points: policy.points,
      duration: policy.durationSeconds,
    });
  }
  return new RateLimiterMemory({
    keyPrefix,
    points: policy.points,
    duration: policy.durationSeconds,
  });
}

const limiterCache = new Map<string, Limiter>();

function getLimiter(policy: RateLimitPolicy): Limiter {
  const cacheKey = `${policy.endpoint}:${policy.identity}`;
  let limiter = limiterCache.get(cacheKey);
  if (!limiter) {
    limiter = buildLimiter(policy);
    limiterCache.set(cacheKey, limiter);
  }
  return limiter;
}

  messageLimiter = new RateLimiterRedis({
    storeClient: redisClient,
    keyPrefix: 'rl:message',
    points: 10,
    duration: 60,
  });
} else {
  const isTest = process.env.NODE_ENV === 'test';
  generalLimiter = new RateLimiterMemory({ points: isTest ? 10000 : 100, duration: 60 });
  authLimiter = new RateLimiterMemory({ points: isTest ? 10000 : 10, duration: 60 });
  bookingLimiter = new RateLimiterMemory({ points: isTest ? 10000 : 5, duration: 60 });
  blockchainLimiter = new RateLimiterMemory({ points: isTest ? 10000 : 20, duration: 60 });
  messageLimiter = new RateLimiterMemory({ points: isTest ? 10000 : 10, duration: 60 });
}

function setRateLimitHeaders(res: Response, limiterRes: any): void {
  if (!limiterRes) return;
  if (limiterRes.consumedPoints !== undefined) {
    res.setHeader('X-RateLimit-Limit', String(limiterRes.consumedPoints));
  }
  if (limiterRes.remainingPoints !== undefined) {
    res.setHeader('X-RateLimit-Remaining', String(limiterRes.remainingPoints));
  }
  if (limiterRes.msBeforeNext !== undefined) {
    res.setHeader('X-RateLimit-Reset', new Date(Date.now() + limiterRes.msBeforeNext).toISOString());
  }
}

/**
 * Resolve the identity used to key a request.
 * Authenticated callers are keyed by user id; anonymous callers by the
 * validated client IP (never a raw, spoofable forwarded header).
 */
export function resolveIdentity(req: AuthRequest): { identity: IdentityClass; key: string } {
  const userId = req.user?.id ?? req.userId;
  if (userId) {
    return { identity: 'user', key: `user:${userId}` };
  }
  return { identity: 'ip', key: `ip:${getClientIp(req)}` };
}

/**
 * Hash an identity string (IP or userId) before recording it so we don't
 * persist raw personally-identifiable data in the metrics store.
 */
export function hashIdentity(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/**
 * Apply progressive delay based on consecutive failures.
 * This increases the cost of brute-force attacks over time.
 */
async function getProgressiveDelay(
  storeKey: string,
): Promise<number> {
  if (process.env.NODE_ENV === 'test') return 0;
  const failureCountKey = `${storeKey}:failures`;
  const failureCount = await redisClient.incr(failureCountKey);

  // Set expiry on failure counter if first failure
  if (failureCount === 1) {
    await redisClient.expire(failureCountKey, 3600); // 1 hour
  }

  // Progressive delays: 0ms, 100ms, 500ms, 1s, 2s, 5s, 10s...
  const delays = [0, 100, 500, 1000, 2000, 5000, 10000];
  const delayIndex = Math.min(failureCount - 1, delays.length - 1);

  return delays[delayIndex] || 10000; // Cap at 10 seconds
}

/**
 * Record a rate-limit rejection and send the 429 response.
 * Identity is hashed before storage — raw IPs/user IDs are never persisted.
 * Applies progressive delays to discourage brute-force attacks.
 * Records metrics for monitoring and alerting.
 */
async function handleRejection(
  req: Request,
  res: Response,
  limiterRes: any,
  scope: string,
  rawIdentity: string,
  message: string,
): Promise<void> {
  setRateLimitHeaders(res, limiterRes);
  if (limiterRes?.msBeforeNext !== undefined) {
    res.setHeader('Retry-After', String(Math.ceil(limiterRes.msBeforeNext / 1000)));
  }

  // Record the rejection — identity is hashed for privacy
  const hashedIdentity = hashIdentity(rawIdentity);
  const storeKey = `abuse:${scope}:${hashedIdentity}`;

  await rateLimitStore.record({
    route: req.path,
    method: req.method,
    scope,
    hashedIdentity,
    timestamp: Date.now(),
  });

  // Track abuse metrics
  await rateLimitMetrics.recordEvent(req.path, req.method, scope, hashedIdentity);

  // Calculate progressive delay
  const progressiveDelay = await getProgressiveDelay(storeKey);

  loggingService.logBlockchainOperation(
    'rate_limit_exceeded',
    { scope, route: req.path, method: req.method, progressiveDelay },
    undefined,
    message,
  );

  // Apply progressive delay before sending response
  if (progressiveDelay > 0) {
    await new Promise(resolve => setTimeout(resolve, progressiveDelay));
  }

  res.status(429).json({
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message,
      details: {
        retryAfter: retryAfterSeconds + Math.ceil(progressiveDelay / 1000),
      },
    },
  });
}

export function generalRateLimiter(req: Request, res: Response, next: NextFunction): void {
  if (process.env.NODE_ENV === 'test') return next();
  const key = req.ip || 'unknown';

  generalLimiter
    .consume(key)
    .then((limiterRes) => {
      setRateLimitHeaders(res, limiterRes);
      next();
    })
    .catch((limiterRes) => {
      handleRejection(req, res, limiterRes, 'general', key, 'Too many requests, please try again later.');
    });
}

  const userLimiter = getLimiter(userPolicy);
  const ipLimiter = getLimiter(ipPolicy);

  const rejectionMessage = message ?? 'Too many requests, please try again later.';

  return function rateLimiterMiddleware(
    req: AuthRequest,
    res: Response,
    next: NextFunction,
  ): void {
    const { identity, key } = resolveIdentity(req);
    const limiter = identity === 'user' ? userLimiter : ipLimiter;

    limiter
      .consume(key)
      .then((limiterRes) => {
        setRateLimitHeaders(res, limiterRes);
        next();
      })
      .catch((limiterRes) => {
        handleRejection(req, res, limiterRes, endpoint, key, rejectionMessage);
      });
  };
}

export const generalRateLimiter = createRateLimiter(
  'general',
  undefined,
  'Too many requests, please try again later.',
);

export const authRateLimiter = createRateLimiter(
  'login',
  undefined,
  'Too many authentication requests, please try again later.',
);

export const searchRateLimiter = createRateLimiter(
  'search',
  undefined,
  'Too many search requests, please slow down.',
);

export const uploadRateLimiter = createRateLimiter(
  'upload',
  undefined,
  'Too many upload requests, please try again later.',
);

export const bookingRateLimiter = createRateLimiter(
  'expensive',
  undefined,
  'Too many booking requests, please try again later.',
);

export const blockchainRateLimiter = createRateLimiter(
  'expensive',
  undefined,
  'Too many blockchain operations, please try again later.',
);

export const messageRateLimiter = createRateLimiter(
  'message',
  undefined,
  'Too many messages sent, please slow down.',
);

/**
 * Factory that creates a per-user rate-limiter middleware.
 *
 * The limiter key is resolved from `req.user?.id` (the authenticated user id)
 * so that two users sharing the same NAT/IP are tracked independently.
 * When no authenticated user is present the key falls back to the client IP.
 *
 * @param windowMs  - Sliding window length in milliseconds.
 * @param max       - Maximum number of requests allowed in the window.
 * @param keyPrefix - Redis key namespace (e.g. "rl:user:booking").
 *
 * @example
 * ```ts
 * const bookingCreationLimiter = createUserRateLimiter({
 *   windowMs: env.BOOKING_RATE_LIMIT_WINDOW_MS,
 *   max: env.BOOKING_RATE_LIMIT_MAX,
 *   keyPrefix: 'rl:user:booking',
 * });
 * ```
 */
export function createUserRateLimiter({
  windowMs,
  max,
  keyPrefix,
}: {
  windowMs: number;
  max: number;
  keyPrefix: string;
}): (req: AuthRequest, res: Response, next: NextFunction) => void {
  const durationSeconds = Math.ceil(windowMs / 1000);

  // Namespace the custom limiter through the centralized key builder so it
  // shares the same layout as the built-in endpoint classes across instances.
  const namespacedPrefix = redisKeys.rateLimitCustom(keyPrefix);

  const limiter: RateLimiterRedis | RateLimiterMemory = useRedis
    ? new RateLimiterRedis({
        storeClient: redisClient,
        keyPrefix: namespacedPrefix,
        points: max,
        duration: durationSeconds,
      })
    : new RateLimiterMemory({ keyPrefix: namespacedPrefix, points: max, duration: durationSeconds });

  return function userRateLimiterMiddleware(
    req: AuthRequest,
    res: Response,
    next: NextFunction,
  ): void {
    if (process.env.NODE_ENV === 'test' && !keyPrefix.startsWith('test')) {
      return next();
    }
    // Prefer authenticated user id; fall back to IP for unauthenticated callers.
    const rawIdentity = req.user?.id ?? req.userId ?? req.ip ?? 'unknown';

    limiter
      .consume(rawIdentity)
      .then((limiterRes) => {
        setRateLimitHeaders(res, limiterRes);
        next();
      })
      .catch((limiterRes) => {
        handleRejection(
          req,
          res,
          limiterRes,
          keyPrefix,
          rawIdentity,
          'Too many booking requests. Please slow down and try again later.',
        );
      });
  };
}

// Backward compatibility export
export const rateLimiter = generalRateLimiter;
