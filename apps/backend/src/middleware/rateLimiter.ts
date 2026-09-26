import type { Request, Response, NextFunction } from 'express';
import { RateLimiterRedis, RateLimiterMemory } from 'rate-limiter-flexible';
import { createHash } from 'node:crypto';
import { redisClient } from '@/config/redis.js';
import { loggingService } from '@/services/logging.service.js';
import { rateLimitStore } from '@/services/rateLimitStore.service.js';
import { rateLimitMetrics } from '@/services/rateLimitMetrics.service.js';

export interface AuthRequest extends Request {
  userId?: string;
}

// Rate limiter instances
let generalLimiter: RateLimiterRedis | RateLimiterMemory;
let authLimiter: RateLimiterRedis | RateLimiterMemory;
let bookingLimiter: RateLimiterRedis | RateLimiterMemory;
let blockchainLimiter: RateLimiterRedis | RateLimiterMemory;
let messageLimiter: RateLimiterRedis | RateLimiterMemory;

const useRedis = !!process.env.REDIS_URL;

if (useRedis) {
  generalLimiter = new RateLimiterRedis({
    storeClient: redisClient,
    keyPrefix: 'rl:general',
    points: 100,
    duration: 60,
  });

  authLimiter = new RateLimiterRedis({
    storeClient: redisClient,
    keyPrefix: 'rl:auth',
    points: 10,
    duration: 60,
  });

  bookingLimiter = new RateLimiterRedis({
    storeClient: redisClient,
    keyPrefix: 'rl:booking',
    points: 5,
    duration: 60,
  });

  blockchainLimiter = new RateLimiterRedis({
    storeClient: redisClient,
    keyPrefix: 'rl:blockchain',
    points: 20,
    duration: 60,
  });

  messageLimiter = new RateLimiterRedis({
    storeClient: redisClient,
    keyPrefix: 'rl:message',
    points: 10,
    duration: 60,
  });
} else {
  generalLimiter = new RateLimiterMemory({ points: 100, duration: 60 });
  authLimiter = new RateLimiterMemory({ points: 10, duration: 60 });
  bookingLimiter = new RateLimiterMemory({ points: 5, duration: 60 });
  blockchainLimiter = new RateLimiterMemory({ points: 20, duration: 60 });
  messageLimiter = new RateLimiterMemory({ points: 10, duration: 60 });
}

function setRateLimitHeaders(res: Response, limiterRes: any): void {
  res.setHeader('X-RateLimit-Limit', limiterRes.consumedPoints);
  res.setHeader('X-RateLimit-Remaining', limiterRes.remainingPoints);
  res.setHeader('X-RateLimit-Reset', new Date(Date.now() + limiterRes.msBeforeNext).toISOString());
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
  res.setHeader('Retry-After', Math.ceil(limiterRes.msBeforeNext / 1000));

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
        retryAfter: Math.ceil(limiterRes.msBeforeNext / 1000) + Math.ceil(progressiveDelay / 1000),
      },
    },
  });
}

export function generalRateLimiter(req: Request, res: Response, next: NextFunction): void {
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

export function authRateLimiter(req: Request, res: Response, next: NextFunction): void {
  const key = req.ip || 'unknown';

  authLimiter
    .consume(key)
    .then((limiterRes) => {
      setRateLimitHeaders(res, limiterRes);
      next();
    })
    .catch((limiterRes) => {
      handleRejection(req, res, limiterRes, 'auth', key, 'Too many authentication requests, please try again later.');
    });
}

export function bookingRateLimiter(req: AuthRequest, res: Response, next: NextFunction): void {
  const key = req.userId || req.ip || 'unknown';

  bookingLimiter
    .consume(key)
    .then((limiterRes) => {
      setRateLimitHeaders(res, limiterRes);
      next();
    })
    .catch((limiterRes) => {
      handleRejection(req, res, limiterRes, 'booking', key, 'Too many booking requests, please try again later.');
    });
}

export function blockchainRateLimiter(req: AuthRequest, res: Response, next: NextFunction): void {
  const key = req.userId || req.ip || 'unknown';

  blockchainLimiter
    .consume(key)
    .then((limiterRes) => {
      setRateLimitHeaders(res, limiterRes);
      next();
    })
    .catch((limiterRes) => {
      handleRejection(req, res, limiterRes, 'blockchain', key, 'Too many blockchain operations, please try again later.');
    });
}

export function messageRateLimiter(req: AuthRequest, res: Response, next: NextFunction): void {
  const key = req.userId || req.ip || 'unknown';

  messageLimiter
    .consume(key)
    .then((limiterRes) => {
      setRateLimitHeaders(res, limiterRes);
      next();
    })
    .catch((limiterRes) => {
      handleRejection(req, res, limiterRes, 'message', key, 'Too many messages sent, please slow down.');
    });
}

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

  const limiter: RateLimiterRedis | RateLimiterMemory = useRedis
    ? new RateLimiterRedis({
        storeClient: redisClient,
        keyPrefix,
        points: max,
        duration: durationSeconds,
      })
    : new RateLimiterMemory({ keyPrefix, points: max, duration: durationSeconds });

  return function userRateLimiterMiddleware(
    req: AuthRequest,
    res: Response,
    next: NextFunction,
  ): void {
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
