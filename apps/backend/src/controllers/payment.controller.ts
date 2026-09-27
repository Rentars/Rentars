/**
 * Payment controller — handles USDC payment submission, status polling, and retry.
 *
 * #618: Every submit/retry is gated by per-user/per-booking attempt limits and
 * provider circuit breakers. When the circuit is open, clients receive a truthful
 * Retry-After. In-flight confirmations continue via the backpressure queue.
 */

import type { Response } from 'express';
import { z } from 'zod';
import type { AuthRequest } from '@/middleware/auth.middleware.js';
import {
  createPaymentIntent,
  getPaymentStatus,
  updatePaymentStatus,
} from '@/services/payment.service.js';
import {
  submitTransaction,
  confirmTransaction,
  retryTransaction,
} from '@/services/stellar.service.js';
import {
  allowPaymentCall,
  recordProviderFailure,
  recordProviderSuccess,
} from '@/services/paymentCircuitBreaker.service.js';
import {
  gatePaymentAttempt,
  enqueuePaymentWork,
} from '@/services/paymentAttemptLimiter.service.js';
import { usdcToStroops } from '@/utils/payment.utils.js';
import { hashRequestBody, lookup, store } from '@/services/idempotency.service.js';

const submitSchema = z.object({
  bookingId: z.string().uuid('bookingId must be a valid UUID'),
  signedXdr: z.string().min(1, 'signedXdr is required'),
  amountUsdc: z.union([z.number().positive(), z.string().min(1)]),
  metadata: z.record(z.unknown()).optional(),
});

const retrySchema = z.object({
  signedXdr: z.string().optional(),
});

function rejectWithRetry(
  res: Response,
  status: number,
  code: string,
  message: string,
  retryAfterSeconds: number,
  extra: Record<string, unknown> = {},
): void {
  res.setHeader('Retry-After', String(Math.max(1, retryAfterSeconds)));
  res.status(status).json({
    error: {
      code,
      message,
      details: { retryAfter: Math.max(1, retryAfterSeconds), ...extra },
    },
  });
}

/**
 * POST /api/v1/payments/submit
 */
export async function submitPayment(req: AuthRequest, res: Response): Promise<void> {
  const parsed = submitSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', details: parsed.error.flatten().fieldErrors } });
    return;
  }

  const { bookingId, signedXdr, amountUsdc, metadata } = parsed.data;
  const tenantId = req.userId!;
  const idempotencyKey = (req.headers['idempotency-key'] as string | undefined)?.trim();

  // Idempotent replay
  if (idempotencyKey) {
    const existing = await lookup(tenantId, idempotencyKey);
    if (existing.success && existing.data?.status === 'completed') {
      const currentHash = hashRequestBody(parsed.data);
      if (existing.data.request_hash === currentHash) {
        res.status(existing.data.status_code).json(existing.data.response_body);
        return;
      }
      res.status(422).json({
        error: { code: 'IDEMPOTENCY_KEY_REUSED', message: 'Idempotency key reused with a different payload' },
      });
      return;
    }
  }

  // Per-user / per-booking attempt limits
  const attemptGate = await gatePaymentAttempt(tenantId, bookingId, idempotencyKey);
  if (!attemptGate.allowed) {
    rejectWithRetry(
      res,
      429,
      'PAYMENT_ATTEMPT_LIMIT',
      attemptGate.reason ?? 'Payment attempt limit exceeded',
      attemptGate.retryAfterSeconds,
      {
        userAttempts: attemptGate.userAttempts,
        bookingAttempts: attemptGate.bookingAttempts,
      },
    );
    return;
  }

  // Provider circuit breaker — stop generating external calls when open
  const circuit = await allowPaymentCall('stellar_horizon');
  if (!circuit.allowed) {
    rejectWithRetry(
      res,
      503,
      'PAYMENT_CIRCUIT_OPEN',
      circuit.reason ?? 'Payment provider temporarily unavailable',
      circuit.circuit.retryAfterSeconds || 30,
      { provider: 'stellar_horizon', circuitState: circuit.circuit.state },
    );
    return;
  }

  const amountStroops =
    typeof amountUsdc === 'number'
      ? usdcToStroops(String(amountUsdc))
      : usdcToStroops(amountUsdc);

  // 1. Create payment intent in 'pending' state
  let payment;
  try {
    payment = await createPaymentIntent({
      bookingId,
      tenantId,
      amountStroops,
      metadata,
    });
  } catch (err) {
    res.status(500).json({
      error: {
        code: 'PAYMENT_INTENT_FAILED',
        message: err instanceof Error ? err.message : 'Failed to create payment intent',
      },
    });
    return;
  }

  // 2. Submit signed XDR to Stellar
  let txHash: string;
  try {
    const result = await submitTransaction(signedXdr);
    txHash = result.txHash;
    await updatePaymentStatus(payment.id, txHash, 'submitted');
    await recordProviderSuccess('stellar_horizon');
  } catch (err) {
    await updatePaymentStatus(payment.id, null, 'failed');
    await recordProviderFailure(
      'stellar_horizon',
      err instanceof Error ? err.message : 'submit failed',
    );
    res.status(502).json({
      error: {
        code: 'TX_SUBMIT_FAILED',
        message: err instanceof Error ? err.message : 'Transaction submission failed',
        details: {
          paymentId: payment.id,
          bookingId,
        },
      },
    });
    return;
  }

  // 3. Kick off async confirmation under backpressure queue
  enqueuePaymentWork(() => confirmTransaction(payment.id, txHash)).catch((err) => {
    console.error('[Payment] Confirmation polling failed for', payment.id, err);
  });

  const body = { paymentId: payment.id, status: 'submitted', txHash };
  if (idempotencyKey) {
    await store(tenantId, idempotencyKey, hashRequestBody(parsed.data), body, 202);
  }

  res.status(202).json(body);
}

/**
 * GET /api/v1/payments/:id/status
 */
export async function getStatus(req: AuthRequest, res: Response): Promise<void> {
  const { id } = req.params;
  const payment = await getPaymentStatus(id);

  if (!payment) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Payment not found' } });
    return;
  }

  if (payment.tenant_id !== req.userId && req.user?.role !== 'admin') {
    res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Access denied' } });
    return;
  }

  res.json({
    paymentId: payment.id,
    bookingId: payment.booking_id,
    status: payment.status,
    txHash: payment.stellar_tx_hash,
    amountStroops: payment.amount_stroops.toString(),
    updatedAt: payment.updated_at,
  });
}

/**
 * POST /api/v1/payments/:id/retry
 */
export async function retryPayment(req: AuthRequest, res: Response): Promise<void> {
  const { id } = req.params;

  const parsed = retrySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', details: parsed.error.flatten().fieldErrors } });
    return;
  }

  const payment = await getPaymentStatus(id);
  if (!payment) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Payment not found' } });
    return;
  }

  if (payment.tenant_id !== req.userId) {
    res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Access denied' } });
    return;
  }

  const attemptGate = await gatePaymentAttempt(req.userId!, payment.booking_id);
  if (!attemptGate.allowed) {
    rejectWithRetry(
      res,
      429,
      'PAYMENT_ATTEMPT_LIMIT',
      attemptGate.reason ?? 'Payment attempt limit exceeded',
      attemptGate.retryAfterSeconds,
    );
    return;
  }

  const circuit = await allowPaymentCall('stellar_horizon');
  if (!circuit.allowed) {
    rejectWithRetry(
      res,
      503,
      'PAYMENT_CIRCUIT_OPEN',
      circuit.reason ?? 'Payment provider temporarily unavailable',
      circuit.circuit.retryAfterSeconds || 30,
      { provider: 'stellar_horizon', circuitState: circuit.circuit.state },
    );
    return;
  }

  try {
    const result = await enqueuePaymentWork(() =>
      retryTransaction(id, parsed.data.signedXdr),
    );
    await recordProviderSuccess('stellar_horizon');
    res.json({ paymentId: id, txHash: result.txHash, status: result.status });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'PAYMENT_QUEUE_DEFERRED') {
      rejectWithRetry(
        res,
        503,
        'PAYMENT_QUEUE_DEFERRED',
        err instanceof Error ? err.message : 'Queue saturated',
        (err as { retryAfterSeconds?: number }).retryAfterSeconds ?? 15,
      );
      return;
    }
    await recordProviderFailure(
      'stellar_horizon',
      err instanceof Error ? err.message : 'retry failed',
    );
    res.status(422).json({
      error: {
        code: 'RETRY_FAILED',
        message: err instanceof Error ? err.message : 'Retry failed',
      },
    });
  }
}
