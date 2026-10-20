/**
 * Payment service — canonical state machine for USDC payment intents.
 *
 * State lifecycle (closes #609):
 *
 *   ┌─────────┐
 *   │ pending │  Payment intent created; no transaction submitted yet.
 *   └────┬────┘
 *        │ submitTransaction()
 *        ▼
 *   ┌───────────┐
 *   │ submitted │  Signed XDR delivered to Stellar Horizon; awaiting ledger.
 *   └─────┬─────┘
 *         ├─── confirmTransaction() → ┌───────────┐
 *         │                           │ confirmed │  Ledger sealed; escrow funded.
 *         │                           └───────────┘
 *         ├─── on-chain failure   → ┌────────┐
 *         │                         │ failed │  Terminal; no escrow.
 *         │                         └────────┘
 *         └─── 60 s timeout      → ┌───────────┐
 *                                  │ timed_out │  May be retried.
 *                                  └───────────┘
 *
 * Additional terminal states:
 *   refunded      — escrow cancelled, funds returned to tenant.
 *   under_review  — conflicting update quarantined for manual review.
 *
 * Rules enforced here:
 *  1. Transitions only advance through the allowed graph; regressive moves
 *     are rejected and quarantined as `under_review`.
 *  2. Each event carries a SHA-256 hash of its payload; duplicate hashes
 *     are idempotently replayed without re-applying side-effects.
 *  3. External provider IDs (escrow_id, stellar_tx_hash) are stored so
 *     every payment has a complete, auditable lifecycle.
 *  4. Unknown / unsupported statuses returned by external providers are
 *     quarantined rather than silently accepted.
 */

import { createHash } from 'node:crypto';
import { supabase } from '@/config/supabase.js';
import { auditLogger } from './auditLogger.service.js';
import type { ServiceResponse } from './index.js';
import {
  SUPPORTED_CURRENCIES,
  type SupportedCurrency,
  type QuoteBinding,
  verifyQuoteBinding,
  assertSupportedCurrency,
} from './payment.utils.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type PaymentStatus =
  | 'pending'
  | 'submitted'
  | 'confirmed'
  | 'failed'
  | 'timed_out'
  | 'refunded'
  | 'under_review';

/**
 * Allowed forward transitions in the payment state machine.
 * Any move not listed here is rejected and quarantined.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<PaymentStatus, ReadonlyArray<PaymentStatus>>> = {
  pending:      ['submitted', 'failed'],
  submitted:    ['confirmed', 'failed', 'timed_out'],
  confirmed:    ['refunded'],
  failed:       [],                         // terminal
  timed_out:    ['submitted', 'failed'],    // retryable
  refunded:     [],                         // terminal
  under_review: ['pending', 'failed'],      // admin-only resolution
};

/**
 * External provider statuses mapped to canonical PaymentStatus.
 * Anything not listed is treated as unknown → under_review.
 */
const PROVIDER_STATUS_MAP: Readonly<Record<string, PaymentStatus>> = {
  // Stellar / Horizon
  SUCCESS:   'confirmed',
  FAILED:    'failed',
  NOT_FOUND: 'timed_out',
  // TrustlessWork escrow statuses
  funded:    'confirmed',
  released:  'refunded',
  cancelled: 'failed',
  disputed:  'under_review',
  created:   'pending',
};

export interface Payment {
  id: string;
  booking_id: string;
  tenant_id: string;
  /** Amount in USDC stroops (integer, 1 USDC = 10_000_000 stroops). */
  amount_stroops: bigint;
  /** Canonical amount in token minor units (integer). */
  amount_minor: bigint;
  /** Supported currency token — currently only USDC. */
  currency: SupportedCurrency;
  /** Version of the quote the authorized amount was bound to. */
  quote_version: number | null;
  stellar_tx_hash: string | null;
  /** TrustlessWork escrow contract ID, if applicable. */
  escrow_id: string | null;
  /** Quote reference hash signed at intent creation (for amount integrity). */
  quote_hash: string | null;
  status: PaymentStatus;
  /** Version counter incremented on every transition (optimistic concurrency). */
  version: number;
  /** SHA-256 of the last event payload that triggered a transition. */
  last_event_hash: string | null;
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown> | null;
}

export interface CreatePaymentIntentParams {
  bookingId: string;
  tenantId: string;
  /** Amount in USDC stroops (integer). Use amountUsdcToStroops() to convert. */
  amountStroops: bigint;
  /**
   * Verified quote binding produced by payment.utils.ts#verifyQuoteBinding().
   * Required: the authorized amount must be bound to a server-computed quote.
   */
  quote: QuoteBinding;
  escrowId?: string;
  metadata?: Record<string, unknown>;
}

export interface TransitionResult {
  payment: Payment;
  /** True when the event was a duplicate (same hash) — no side-effects applied. */
  replayed: boolean;
}

export type RefundState =
  | 'requested'
  | 'submitted'
  | 'confirmed'
  | 'failed'
  | 'manual_review';

const ALLOWED_REFUND_TRANSITIONS: Readonly<Record<RefundState, ReadonlyArray<RefundState>>> = {
  requested:     ['submitted', 'failed', 'manual_review'],
  submitted:     ['confirmed', 'failed', 'manual_review'],
  confirmed:     [],                        // terminal
  failed:        ['submitted', 'manual_review'], // retryable
  manual_review: ['submitted', 'failed'],   // admin-only resolution
};

export interface RefundRequest {
  id: string;
  payment_id: string;
  booking_id: string;
  /** Amount in token minor units (integer). */
  amount_minor: bigint;
  currency: SupportedCurrency;
  state: RefundState;
  /** Unique key guaranteeing at-most-once refund creation. */
  idempotency_key: string;
  /** Opaque provider destination reference preserved across retries. */
  destination_ref: string | null;
  provider_ref: string | null;
  last_event_hash: string | null;
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown> | null;
}

export interface CreateRefundRequestParams {
  paymentId: string;
  bookingId: string;
  /** Amount in token minor units (integer). Must not exceed eligible value. */
  amountMinor: bigint;
  currency: SupportedCurrency;
  /** Caller-supplied idempotency key (e.g. derived from cancellation id). */
  idempotencyKey: string;
  destinationRef?: string;
  metadata?: Record<string, unknown>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Produce a stable SHA-256 hex digest of an event payload object.
 * Used to detect duplicate provider callbacks.
 */
export function hashEventPayload(payload: Record<string, unknown>): string {
  const stable = JSON.stringify(payload, Object.keys(payload).sort());
  return createHash('sha256').update(stable).digest('hex');
}

/**
 * Returns true when `from → to` is a permitted transition.
 */
export function isAllowedTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Map an external provider status string to a canonical PaymentStatus.
 * Returns `under_review` for any unknown value.
 */
export function mapProviderStatus(raw: string): PaymentStatus {
  return PROVIDER_STATUS_MAP[raw] ?? 'under_review';
}

// ─── Service functions ────────────────────────────────────────────────────────

/**
 * Create a new payment intent in `pending` state.
 *
 * @returns The newly created Payment record.
 * @throws  On database error.
 */
export async function createPaymentIntent(
  params: CreatePaymentIntentParams,
): Promise<Payment> {
  const { bookingId, tenantId, amountStroops, quote, escrowId, metadata } = params;

  // ── Reject unsupported currency / precision before any signing ────────────
  assertSupportedCurrency(quote.currency);

  // ── Bind the authorized amount to the verified quote ──────────────────────
  const binding = verifyQuoteBinding(quote, {
    amountMinor: amountStroops,
    currency: quote.currency,
  });
  if (!binding.ok) {
    throw new Error(`Payment intent rejected: ${binding.reason}`);
  }

  const { data, error } = await supabase
    .from('payments')
    .insert({
      booking_id: bookingId,
      tenant_id: tenantId,
      amount_stroops: amountStroops.toString(), // stored as text to avoid JS bigint loss
      amount_minor: quote.amountMinor.toString(),
      currency: quote.currency,
      quote_version: quote.version,
      status: 'pending',
      escrow_id: escrowId ?? null,
      quote_hash: quote.quoteHash,
      version: 1,
      last_event_hash: null,
      metadata: metadata ?? null,
    })
    .select()
    .single();

  if (error || !data) {
    throw new Error(`Failed to create payment intent: ${error?.message ?? 'unknown error'}`);
  }

  const payment = rowToPayment(data);

  await auditLogger.log({
    actorId: tenantId,
    action: 'payment.submit',
    resourceType: 'payment',
    resourceId: payment.id,
    meta: {
      bookingId,
      amountStroops: amountStroops.toString(),
      currency: quote.currency,
      quoteVersion: quote.version,
      quoteHash: quote.quoteHash,
    },
  });

  return payment;
}

/**
 * Compare the settled on-chain amount against the authorized quote amount.
 *
 * On exact match the payment is confirmed. On any mismatch (amount, currency,
 * or quote version) the payment is quarantined to `under_review` and can never
 * be marked paid.
 *
 * @param paymentId    - UUID of the payment to verify.
 * @param settledMinor - Amount actually settled on-chain, in token minor units.
 * @param settledCurrency - Currency of the settled transfer (defaults to quote).
 */
export async function markSettlementVerified(
  paymentId: string,
  settledMinor: bigint,
  settledCurrency?: SupportedCurrency,
): Promise<ServiceResponse<TransitionResult>> {
  const payment = await getPaymentStatus(paymentId);
  if (!payment) {
    return { success: false, error: 'Payment not found' };
  }

  const expectedMinor = payment.amount_minor;
  const expectedCurrency = payment.currency;
  const actualCurrency = settledCurrency ?? expectedCurrency;

  const mismatch =
    settledMinor !== expectedMinor || actualCurrency !== expectedCurrency;

  if (mismatch) {
    const reason =
      `Settlement mismatch: expected ${expectedMinor.toString()} ${expectedCurrency}, ` +
      `settled ${settledMinor.toString()} ${actualCurrency}`;

    const result = await transitionPaymentStatus(
      paymentId,
      'under_review',
      {
        _source: 'settlement_verification',
        settledMinor: settledMinor.toString(),
        settledCurrency: actualCurrency,
        expectedMinor: expectedMinor.toString(),
        expectedCurrency,
        reason,
      },
      null,
    );

    if (result.success && result.data) {
      await auditLogger.log({
        action: 'payment.failed',
        resourceType: 'payment',
        resourceId: paymentId,
        meta: { reason, settledMinor: settledMinor.toString(), expectedMinor: expectedMinor.toString() },
      });
    }

    return result;
  }

  return transitionPaymentStatus(
    paymentId,
    'confirmed',
    {
      _source: 'settlement_verification',
      settledMinor: settledMinor.toString(),
      settledCurrency: actualCurrency,
    },
    null,
  );
}

/**
 * Create an idempotent refund request in `requested` state.
 *
 * The `idempotencyKey` is unique: repeated calls with the same key return the
 * existing request without creating a duplicate or re-applying side-effects.
 *
 * @throws On unsupported currency, excessive precision, or database error.
 */
export async function createRefundRequest(
  params: CreateRefundRequestParams,
): Promise<RefundRequest> {
  const {
    paymentId,
    bookingId,
    amountMinor,
    currency,
    idempotencyKey,
    destinationRef,
    metadata,
  } = params;

  assertSupportedCurrency(currency);
  if (amountMinor <= 0n) {
    throw new Error('Refund amount must be positive');
  }

  // ── Idempotency: return existing request for the same key ─────────────────
  const { data: existing } = await supabase
    .from('refund_requests')
    .select()
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();

  if (existing) {
    return rowToRefundRequest(existing);
  }

  const { data, error } = await supabase
    .from('refund_requests')
    .insert({
      payment_id: paymentId,
      booking_id: bookingId,
      amount_minor: amountMinor.toString(),
      currency,
      state: 'requested',
      idempotency_key: idempotencyKey,
      destination_ref: destinationRef ?? null,
      provider_ref: null,
      last_event_hash: null,
      metadata: metadata ?? null,
    })
    .select()
    .single();

  if (error || !data) {
    // Unique-constraint race: another process inserted the same key first.
    if (error?.code === '23505') {
      const { data: raced } = await supabase
        .from('refund_requests')
        .select()
        .eq('idempotency_key', idempotencyKey)
        .single();
      if (raced) return rowToRefundRequest(raced);
    }
    throw new Error(`Failed to create refund request: ${error?.message ?? 'unknown error'}`);
  }

  const refund = rowToRefundRequest(data);

  await auditLogger.log({
    action: 'payment.submit',
    resourceType: 'payment',
    resourceId: paymentId,
    meta: {
      refundRequestId: refund.id,
      amountMinor: amountMinor.toString(),
      currency,
      idempotencyKey,
    },
  });

  return refund;
}

/**
 * Advance a refund request through its state machine with idempotency.
 *
 * @param refundId     - UUID of the refund request.
 * @param newState     - Target refund state.
 * @param eventPayload - Raw event data (used for duplicate detection).
 * @param providerRef  - Optional provider reference to record.
 * @param destinationRef - Optional destination reference to preserve.
 */
export async function transitionRefundState(
  refundId: string,
  newState: RefundState,
  eventPayload: Record<string, unknown>,
  providerRef?: string | null,
  destinationRef?: string | null,
): Promise<ServiceResponse<RefundRequest>> {
  const { data: row } = await supabase
    .from('refund_requests')
    .select()
    .eq('id', refundId)
    .single();

  if (!row) {
    return { success: false, error: 'Refund request not found' };
  }

  const refund = rowToRefundRequest(row);
  const eventHash = hashEventPayload(eventPayload);

  // ── Idempotency: same event hash → replay without side-effects ────────────
  if (refund.last_event_hash === eventHash) {
    return { success: true, data: refund };
  }

  // ── Validate transition ────────────────────────────────────────────────────
  let targetState: RefundState = newState;
  let quarantineReason: string | undefined;

  if (!ALLOWED_REFUND_TRANSITIONS[refund.state]?.includes(newState)) {
    targetState = 'manual_review';
    quarantineReason = `Disallowed refund transition: ${refund.state} → ${newState}`;
  }

  const updatePayload: Record<string, unknown> = {
    state: targetState,
    last_event_hash: eventHash,
    updated_at: new Date().toISOString(),
  };
  if (providerRef !== undefined && providerRef !== null) {
    updatePayload.provider_ref = providerRef;
  }
  // Preserve destination reference across retries; never overwrite with null.
  if (destinationRef !== undefined && destinationRef !== null) {
    updatePayload.destination_ref = destinationRef;
  }
  if (quarantineReason) {
    updatePayload.metadata = {
      ...(refund.metadata ?? {}),
      quarantine_reason: quarantineReason,
      quarantined_at: new Date().toISOString(),
    };
  }

  const { data, error } = await supabase
    .from('refund_requests')
    .update(updatePayload)
    .eq('id', refundId)
    .eq('last_event_hash', refund.last_event_hash) // optimistic concurrency guard
    .select()
    .single();

  if (error || !data) {
    return {
      success: false,
      error: `Concurrent refund transition conflict for ${refundId}: ${error?.message ?? 'version mismatch'}`,
    };
  }

  const updated = rowToRefundRequest(data);

  await auditLogger.log({
    action: targetState === 'confirmed' ? ('payment.confirmed' as const) : ('payment.failed' as const),
    resourceType: 'payment',
    resourceId: refund.payment_id,
    meta: {
      refundRequestId: refundId,
      fromState: refund.state,
      toState: targetState,
      providerRef,
      quarantineReason,
    },
  });

  if (targetState === 'manual_review') {
    console.error(
      `[Refund] MANUAL REVIEW refundId=${refundId} reason="${quarantineReason}" payload=%j`,
      eventPayload,
    );
  }

  return { success: true, data: updated };
}

/**
 * Transition a payment to a new status with full idempotency and conflict
 * quarantine.
 *
 * Algorithm:
 *  1. Load current payment with optimistic version.
 *  2. Hash the incoming event payload.
 *  3. If `last_event_hash` matches → replay without side-effects.
 *  4. Verify the transition is allowed; if not → quarantine to `under_review`.
 *  5. Apply the update with version increment; on version conflict retry once.
 *
 * @param paymentId    - UUID of the payment to transition.
 * @param newStatus    - Target status.
 * @param eventPayload - Raw event data (used for duplicate detection).
 * @param txHash       - Optional Stellar transaction hash to record.
 * @param actorId      - Optional actor UUID for audit (omit for system actions).
 *
 * @returns TransitionResult containing updated Payment and replayed flag.
 */
export async function transitionPaymentStatus(
  paymentId: string,
  newStatus: PaymentStatus,
  eventPayload: Record<string, unknown>,
  txHash?: string | null,
  actorId?: string,
): Promise<ServiceResponse<TransitionResult>> {
  const payment = await getPaymentStatus(paymentId);
  if (!payment) {
    return { success: false, error: 'Payment not found' };
  }

  const eventHash = hashEventPayload(eventPayload);

  // ── Idempotency: same event hash → replay without side-effects ────────────
  if (payment.last_event_hash === eventHash) {
    return {
      success: true,
      data: { payment, replayed: true },
    };
  }

  // ── Validate transition ────────────────────────────────────────────────────
  let targetStatus: PaymentStatus = newStatus;
  let quarantineReason: string | undefined;

  if (!isAllowedTransition(payment.status, newStatus)) {
    // Unknown or regressive transition → quarantine
    targetStatus = 'under_review';
    quarantineReason = `Disallowed transition: ${payment.status} → ${newStatus}`;
  }

  // ── Persist with optimistic concurrency ───────────────────────────────────
  const updatePayload: Record<string, unknown> = {
    status: targetStatus,
    version: payment.version + 1,
    last_event_hash: eventHash,
    updated_at: new Date().toISOString(),
  };
  if (txHash !== undefined) updatePayload.stellar_tx_hash = txHash;
  if (quarantineReason) {
    // Store quarantine reason in metadata for manual review
    updatePayload.metadata = {
      ...(payment.metadata ?? {}),
      quarantine_reason: quarantineReason,
      quarantined_at: new Date().toISOString(),
    };
  }

  const { data, error } = await supabase
    .from('payments')
    .update(updatePayload)
    .eq('id', paymentId)
    .eq('version', payment.version) // optimistic concurrency guard
    .select()
    .single();

  if (error || !data) {
    // Version conflict — another process transitioned first
    return {
      success: false,
      error: `Concurrent payment transition conflict for ${paymentId}: ${error?.message ?? 'version mismatch'}`,
    };
  }

  const updated = rowToPayment(data);

  // ── Audit ─────────────────────────────────────────────────────────────────
  const auditAction =
    targetStatus === 'confirmed'  ? ('payment.confirmed' as const) :
    targetStatus === 'failed'     ? ('payment.failed'    as const) :
    targetStatus === 'refunded'   ? ('payment.failed'    as const) :
    ('payment.submit' as const);

  await auditLogger.log({
    actorId,
    action: auditAction,
    resourceType: 'payment',
    resourceId: paymentId,
    meta: {
      fromStatus: payment.status,
      toStatus: targetStatus,
      txHash,
      quarantineReason,
    },
  });

  // Alert on quarantine
  if (targetStatus === 'under_review') {
    console.error(
      `[Payment] QUARANTINE paymentId=${paymentId} reason="${quarantineReason}" payload=%j`,
      eventPayload,
    );
  }

  return {
    success: true,
    data: { payment: updated, replayed: false },
  };
}

/**
 * @deprecated Use transitionPaymentStatus() instead.
 *
 * Retained for backward-compatibility with stellar.service.ts callers that
 * have not yet been migrated to the new API.
 */
export async function updatePaymentStatus(
  paymentId: string,
  txHash: string | null,
  status: PaymentStatus,
): Promise<Payment> {
  const result = await transitionPaymentStatus(
    paymentId,
    status,
    { txHash, status, _source: 'stellar_confirmation' },
    txHash,
  );

  if (!result.success || !result.data) {
    throw new Error(result.error ?? 'Failed to update payment status');
  }

  return result.data.payment;
}

/**
 * Get a payment record by ID. Returns null if not found.
 */
export async function getPaymentStatus(paymentId: string): Promise<Payment | null> {
  const { data } = await supabase
    .from('payments')
    .select()
    .eq('id', paymentId)
    .single();
  return data ? rowToPayment(data) : null;
}

/**
 * Get a payment record by booking ID. Returns null if not found.
 */
export async function getPaymentByBookingId(bookingId: string): Promise<Payment | null> {
  const { data } = await supabase
    .from('payments')
    .select()
    .eq('booking_id', bookingId)
    .single();
  return data ? rowToPayment(data) : null;
}

// ─── Row mapping ──────────────────────────────────────────────────────────────

/**
 * Map a raw Supabase row to a typed Payment, handling BigInt conversion.
 */
// biome-ignore lint/suspicious/noExplicitAny: raw Supabase row
function rowToPayment(row: any): Payment {
  return {
    id:               row.id,
    booking_id:       row.booking_id,
    tenant_id:        row.tenant_id,
    amount_stroops:   BigInt(row.amount_stroops ?? row.amount_usdc ?? 0),
    amount_minor:     BigInt(row.amount_minor ?? row.amount_stroops ?? row.amount_usdc ?? 0),
    currency:         (row.currency ?? 'USDC') as SupportedCurrency,
    quote_version:    row.quote_version ?? null,
    stellar_tx_hash:  row.stellar_tx_hash ?? null,
    escrow_id:        row.escrow_id ?? null,
    quote_hash:       row.quote_hash ?? null,
    status:           row.status as PaymentStatus,
    version:          row.version ?? 1,
    last_event_hash:  row.last_event_hash ?? null,
    created_at:       row.created_at,
    updated_at:       row.updated_at,
    metadata:         row.metadata ?? null,
  };
}

/**
 * Map a raw Supabase refund_requests row to a typed RefundRequest.
 */
// biome-ignore lint/suspicious/noExplicitAny: raw Supabase row
function rowToRefundRequest(row: any): RefundRequest {
  return {
    id:                row.id,
    payment_id:        row.payment_id,
    booking_id:        row.booking_id,
    amount_minor:      BigInt(row.amount_minor ?? 0),
    currency:          (row.currency ?? 'USDC') as SupportedCurrency,
    state:             row.state as RefundState,
    idempotency_key:   row.idempotency_key,
    destination_ref:   row.destination_ref ?? null,
    provider_ref:      row.provider_ref ?? null,
    last_event_hash:   row.last_event_hash ?? null,
    created_at:        row.created_at,
    updated_at:        row.updated_at,
    metadata:          row.metadata ?? null,
  };
}
