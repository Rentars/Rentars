/**
 * Payment attempt limits and queue backpressure (#618 / Issue 050).
 *
 * - Per-user and per-booking attempt windows stop retry storms.
 * - Idempotency-key scoped tracking correlates retries of the same intent.
 * - p-limit queue applies backpressure so confirm/reconcile work does not
 *   stampede the provider when the circuit recovers.
 */

import pLimit from 'p-limit';
import { supabase } from '@/config/supabase.js';

export interface AttemptLimitConfig {
  maxPerUser: number;
  maxPerBooking: number;
  windowMs: number;
}

const DEFAULT_LIMITS: AttemptLimitConfig = {
  maxPerUser: Number(process.env.PAYMENT_ATTEMPT_MAX_PER_USER ?? 10),
  maxPerBooking: Number(process.env.PAYMENT_ATTEMPT_MAX_PER_BOOKING ?? 5),
  windowMs: Number(process.env.PAYMENT_ATTEMPT_WINDOW_MS ?? 60_000),
};

interface CounterRow {
  userId: string;
  bookingId: string | null;
  attemptCount: number;
  windowStartedAt: number;
}

const memoryCounters = new Map<string, CounterRow>();

function counterKey(userId: string, bookingId?: string | null): string {
  return `${userId}::${bookingId ?? '_'}`;
}

export interface AttemptGateResult {
  allowed: boolean;
  retryAfterSeconds: number;
  reason?: string;
  userAttempts: number;
  bookingAttempts: number;
}

function freshWindow(now: number, started: number, windowMs: number): boolean {
  return now - started >= windowMs;
}

/**
 * Check and increment payment attempt counters for a user/booking pair.
 * Returns a truthful retry-after when limited.
 */
export async function gatePaymentAttempt(
  userId: string,
  bookingId: string,
  idempotencyKey?: string,
  config: AttemptLimitConfig = DEFAULT_LIMITS,
): Promise<AttemptGateResult> {
  const now = Date.now();

  // User-scoped aggregate (booking_id null sentinel in memory)
  const userKey = counterKey(userId, null);
  let userCounter = memoryCounters.get(userKey);
  if (!userCounter || freshWindow(now, userCounter.windowStartedAt, config.windowMs)) {
    userCounter = { userId, bookingId: null, attemptCount: 0, windowStartedAt: now };
  }

  const bookingKey = counterKey(userId, bookingId);
  let bookingCounter = memoryCounters.get(bookingKey);
  if (!bookingCounter || freshWindow(now, bookingCounter.windowStartedAt, config.windowMs)) {
    bookingCounter = { userId, bookingId, attemptCount: 0, windowStartedAt: now };
  }

  if (userCounter.attemptCount >= config.maxPerUser) {
    const retryAfterSeconds = Math.ceil(
      (config.windowMs - (now - userCounter.windowStartedAt)) / 1000,
    );
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, retryAfterSeconds),
      reason: 'Per-user payment attempt limit exceeded',
      userAttempts: userCounter.attemptCount,
      bookingAttempts: bookingCounter.attemptCount,
    };
  }

  if (bookingCounter.attemptCount >= config.maxPerBooking) {
    const retryAfterSeconds = Math.ceil(
      (config.windowMs - (now - bookingCounter.windowStartedAt)) / 1000,
    );
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, retryAfterSeconds),
      reason: 'Per-booking payment attempt limit exceeded',
      userAttempts: userCounter.attemptCount,
      bookingAttempts: bookingCounter.attemptCount,
    };
  }

  userCounter.attemptCount += 1;
  bookingCounter.attemptCount += 1;
  bookingCounter.windowStartedAt = bookingCounter.windowStartedAt || now;
  userCounter.windowStartedAt = userCounter.windowStartedAt || now;
  memoryCounters.set(userKey, userCounter);
  memoryCounters.set(bookingKey, bookingCounter);

  // Best-effort DB persistence for operator visibility
  try {
    await supabase.from('payment_attempt_counters').upsert(
      {
        user_id: userId,
        booking_id: bookingId,
        idempotency_key: idempotencyKey ?? null,
        attempt_count: bookingCounter.attemptCount,
        window_started_at: new Date(bookingCounter.windowStartedAt).toISOString(),
        last_attempt_at: new Date(now).toISOString(),
      },
      { onConflict: 'user_id,booking_id' },
    );
  } catch {
    // memory counters remain authoritative
  }

  return {
    allowed: true,
    retryAfterSeconds: 0,
    userAttempts: userCounter.attemptCount,
    bookingAttempts: bookingCounter.attemptCount,
  };
}

/** Concurrent confirm/reconcile slots — backpressure when providers recover. */
const confirmConcurrency = Number(process.env.PAYMENT_CONFIRM_CONCURRENCY ?? 5);
const confirmLimit = pLimit(Math.max(1, confirmConcurrency));

let queueDepth = 0;
const maxQueueDepth = Number(process.env.PAYMENT_CONFIRM_QUEUE_MAX ?? 50);

export interface QueueStats {
  depth: number;
  maxDepth: number;
  concurrency: number;
  deferred: boolean;
}

export function getPaymentQueueStats(): QueueStats {
  return {
    depth: queueDepth,
    maxDepth: maxQueueDepth,
    concurrency: confirmConcurrency,
    deferred: queueDepth >= maxQueueDepth,
  };
}

/**
 * Run confirm/reconcile work under backpressure.
 * Rejects with DEFERRED when the queue is saturated — callers should not
 * create new external payment calls; in-flight work already admitted continues.
 */
export async function enqueuePaymentWork<T>(fn: () => Promise<T>): Promise<T> {
  if (queueDepth >= maxQueueDepth) {
    const err = new Error('Payment confirmation queue saturated; deferring new work') as Error & {
      code: string;
      retryAfterSeconds: number;
    };
    err.code = 'PAYMENT_QUEUE_DEFERRED';
    err.retryAfterSeconds = 15;
    throw err;
  }

  queueDepth += 1;
  try {
    return await confirmLimit(fn);
  } finally {
    queueDepth = Math.max(0, queueDepth - 1);
  }
}

/** Test helper. */
export function _resetAttemptCountersForTests(): void {
  memoryCounters.clear();
  queueDepth = 0;
}
