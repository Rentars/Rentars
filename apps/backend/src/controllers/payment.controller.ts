/**
 * Payment controller — handles USDC payment submission, status polling, and retry.
 * No blockchain logic lives here; all Stellar calls go through stellar.service.ts.
 */

import type { Request, Response } from 'express';
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
  parseAmountToMinor,
  isSupportedCurrency,
  type SupportedCurrency,
} from '@/utils/payment.utils.js';

const submitSchema = z.object({
  bookingId: z.string().uuid('bookingId must be a valid UUID'),
  signedXdr: z.string().min(1, 'signedXdr is required'),
  amountUsdc: z.number().positive('amountUsdc must be positive'),
  currency: z.string().min(1).optional(),
  quoteVersion: z.number().int().nonnegative().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const retrySchema = z.object({
  signedXdr: z.string().optional(),
});

/**
 * POST /api/v1/payments/submit
 *
 * Creates a payment intent, submits the signed XDR to Stellar, and begins
 * async confirmation polling (fire-and-forget — client polls for status).
 *
 * Body: { bookingId, signedXdr, amountUsdc, metadata? }
 * Returns: { paymentId, status }
 */
export async function submitPayment(req: AuthRequest, res: Response): Promise<void> {
  const parsed = submitSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', details: parsed.error.flatten().fieldErrors } });
    return;
  }

  const { bookingId, signedXdr, amountUsdc, currency, quoteVersion, metadata } = parsed.data;
  const tenantId = req.userId!;

  // 0. Validate currency support and amount precision before signing/intent creation
  const resolvedCurrency = (currency ?? 'USDC') as SupportedCurrency;
  if (!isSupportedCurrency(resolvedCurrency)) {
    res.status(422).json({
      error: {
        code: 'UNSUPPORTED_CURRENCY',
        message: `Currency ${resolvedCurrency} is not supported`,
      },
    });
    return;
  }

  let amountMinor: bigint;
  try {
    amountMinor = parseAmountToMinor(amountUsdc, resolvedCurrency);
  } catch (err) {
    res.status(422).json({
      error: {
        code: 'INVALID_AMOUNT_PRECISION',
        message: err instanceof Error ? err.message : 'Amount has excessive precision',
      },
    });
    return;
  }

  // 1. Create payment intent in 'pending' state
  const payment = await createPaymentIntent({
    bookingId,
    tenantId,
    amountUsdc,
    amountMinor,
    currency: resolvedCurrency,
    quoteVersion,
    metadata,
  });

  // 2. Submit signed XDR to Stellar
  let txHash: string;
  try {
    const result = await submitTransaction(signedXdr);
    txHash = result.txHash;
    await updatePaymentStatus(payment.id, txHash, 'submitted');
  } catch (err) {
    await updatePaymentStatus(payment.id, null, 'failed');
    res.status(502).json({
      error: {
        code: 'TX_SUBMIT_FAILED',
        message: err instanceof Error ? err.message : 'Transaction submission failed',
      },
    });
    return;
  }

  // 3. Kick off async confirmation polling (does not block the response)
  confirmTransaction(payment.id, txHash).catch((err) => {
    console.error('[Payment] Confirmation polling failed for', payment.id, err);
  });

  res.status(202).json({ paymentId: payment.id, status: 'submitted', txHash });
}

/**
 * GET /api/v1/payments/:id/status
 *
 * Returns the current payment status and tx hash.
 * Frontend polls this every 3 seconds while status is 'submitted'.
 */
export async function getStatus(req: AuthRequest, res: Response): Promise<void> {
  const { id } = req.params;
  const payment = await getPaymentStatus(id);

  if (!payment) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Payment not found' } });
    return;
  }

  // Only the owning tenant or an admin may query
  if (payment.tenant_id !== req.userId && req.user?.role !== 'admin') {
    res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Access denied' } });
    return;
  }

  res.json({
    paymentId: payment.id,
    bookingId: payment.booking_id,
    status: payment.status,
    txHash: payment.stellar_tx_hash,
    amountUsdc: payment.amount_usdc,
    amountMinor: payment.amount_minor,
    currency: payment.currency,
    quoteVersion: payment.quote_version,
    reconciliationState: payment.reconciliation_state,
    settlementVerified: payment.settlement_verified,
    refund: payment.refund
      ? {
          refundId: payment.refund.id,
          status: payment.refund.status,
          amountMinor: payment.refund.amount_minor,
          currency: payment.refund.currency,
          destination: payment.refund.destination,
          updatedAt: payment.refund.updated_at,
        }
      : null,
    updatedAt: payment.updated_at,
  });
}

/**
 * POST /api/v1/payments/:id/retry
 *
 * Retries a failed or timed-out payment safely.
 * If the payment already has a txHash, it re-polls instead of re-submitting.
 *
 * Body: { signedXdr? } — only required if no txHash exists on the payment.
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

  try {
    const result = await retryTransaction(id, parsed.data.signedXdr);
    res.json({ paymentId: id, txHash: result.txHash, status: result.status });
  } catch (err) {
    res.status(422).json({
      error: {
        code: 'RETRY_FAILED',
        message: err instanceof Error ? err.message : 'Retry failed',
      },
    });
  }
}
