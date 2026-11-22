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
 *
 * State ownership (closes #116):
 *
 *  Terminal states (`confirmed`, `refunded`, `failed`) are *contract-owned*.
 *  They may only be entered when the transition is backed by verified
 *  on-chain evidence (a sealed ledger event whose booking, amount and
 *  escrow all match the payment record). Off-chain actors (provider
 *  callbacks, sync services, payment UI) may only *request* a transition;
 *  they can never unilaterally mark funds released or refunded.
 *
 *  Pending states (`pending`, `submitted`, `timed_out`) are *off-chain
 *  owned*: they reflect intent and submission progress and carry no
 *  settlement authority.
 *
 *  When on-chain and provider state disagree, the payment is moved to
 *  `under_review` with the disagreement recorded — it is never silently
 *  resolved in favour of either side.
 */

import { createHash } from 'node:crypto';
import { supabase } from '@/config/supabase.js';
import { auditLogger } from './auditLogger.service.js';
import type { ServiceResponse } from './index.js';

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
  /** Supported currency token — currently only USDC. */
  currency: 'USDC';
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
  /** Quote hash produced by payment.utils.ts#hashQuote() and verified server-side. */
  quoteHash?: string;
  escrowId?: string;
  metadata?: Record<string, unknown>;
}

export interface TransitionResult {
  payment: Payment;
  /** True when the event was a duplicate (same hash) — no side-effects applied. */
  replayed: boolean;
}

/**
 * Verified on-chain evidence required to enter a terminal state.
 *
 * This is the *only* authority that can move a payment to `confirmed`,
 * `refunded` or `failed`. It must be produced by a verifier that has
 * independently confirmed the ledger event (e.g. Horizon transaction
 * lookup + escrow contract read), never by a raw provider callback.
 */
export interface VerifiedChainEvidence {
  /** Stellar transaction hash of the sealed ledger event. */
  txHash: string;
  /** Ledger sequence in which the event was sealed (must be > 0). */
  ledger: number;
  /** Booking the on-chain event belongs to — must match the payment. */
  bookingId: string;
  /** Escrow contract the event was emitted from — must match the payment. */
  escrowId: string;
  /** Amount settled on-chain, in stroops — must match the payment. */
  amountStroops: bigint;
  /** Canonical status the verified event represents. */
  status: Extract<PaymentStatus, 'confirmed' | 'refunded' | 'failed'>;
  /** True only when the verifier authenticated and validated the event. */
  verified: boolean;
}

/** States that represent settlement and are owned by the contract. */
const TERMINAL_STATES: ReadonlySet<PaymentStatus> = new Set([
  'confirmed',
  'refunded',
  'failed',
]);

/** States that represent off-chain intent/progress only. */
const PENDING_STATES: ReadonlySet<PaymentStatus> = new Set([
  'pending',
  'submitted',
  'timed_out',
]);

/** Returns true when `status` is a terminal, contract-owned state. */
export function isTerminalStatus(status: PaymentStatus): boolean {
  return TERMINAL_STATES.has(status);
}

/** Returns true when `status` is a pending, off-chain-owned state. */
export function isPendingStatus(status: PaymentStatus): boolean {
  return PENDING_STATES.has(status);
}

/**
 * Validate that `evidence` is authentic and consistent with `payment`.
 *
 * @returns null when the evidence is valid, otherwise a human-readable
 *          reason describing why it must not be trusted.
 */
export function validateChainEvidence(
  payment: Payment,
  evidence: VerifiedChainEvidence,
): string | null {
  if (!evidence.verified) return 'Chain evidence is not verified';
  if (!evidence.txHash) return 'Chain evidence missing transaction hash';
  if (!Number.isInteger(evidence.ledger) || evidence.ledger <= 0) {
    return 'Chain evidence missing sealed ledger sequence';
  }
  if (evidence.bookingId !== payment.booking_id) {
    return `Chain evidence booking mismatch: ${evidence.bookingId} ≠ ${payment.booking_id}`;
  }
  if (!payment.escrow_id || evidence.escrowId !== payment.escrow_id) {
    return `Chain evidence escrow mismatch: ${evidence.escrowId} ≠ ${payment.escrow_id ?? 'none'}`;
  }
  if (evidence.amountStroops !== payment.amount_stroops) {
    return `Chain evidence amount mismatch: ${evidence.amountStroops} ≠ ${payment.amount_stroops}`;
  }
  if (!isTerminalStatus(evidence.status)) {
    return `Chain evidence status ${evidence.status} is not terminal`;
  }
  return null;
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
  const { bookingId, tenantId, amountStroops, quoteHash, escrowId, metadata } = params;

  const { data, error } = await supabase
    .from('payments')
    .insert({
      booking_id: bookingId,
      tenant_id: tenantId,
      amount_stroops: amountStroops.toString(), // stored as text to avoid JS bigint loss
      currency: 'USDC',
      status: 'pending',
      escrow_id: escrowId ?? null,
      quote_hash: quoteHash ?? null,
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
    meta: { bookingId, amountStroops: amountStroops.toString() },
  });

  return payment;
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
 * @param evidence     - Verified on-chain evidence. REQUIRED to enter any
 *                       terminal state; ignored for pending transitions.
 *
 * @returns TransitionResult containing updated Payment and replayed flag.
 */
export async function transitionPaymentStatus(
  paymentId: string,
  newStatus: PaymentStatus,
  eventPayload: Record<string, unknown>,
  txHash?: string | null,
  actorId?: string,
  evidence?: VerifiedChainEvidence | null,
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

  // ── Terminal states require verified on-chain evidence ────────────────────
  // Off-chain actors (provider callbacks, sync, UI) cannot mark funds
  // released/refunded without verifiable external settlement.
  if (isTerminalStatus(newStatus)) {
    if (!evidence) {
      targetStatus = 'under_review';
      quarantineReason =
        `Terminal transition ${payment.status} → ${newStatus} rejected: ` +
        'missing verified on-chain evidence';
    } else {
      const evidenceError = validateChainEvidence(payment, evidence);
      if (evidenceError) {
        targetStatus = 'under_review';
        quarantineReason = `Terminal transition ${payment.status} → ${newStatus} rejected: ${evidenceError}`;
      } else if (evidence.status !== newStatus) {
        // On-chain and provider state disagree — surface, do not resolve.
        targetStatus = 'under_review';
        quarantineReason =
          `On-chain/provider disagreement: chain reports ${evidence.status}, ` +
          `provider requested ${newStatus}`;
      }
    }
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
  if (evidence && isTerminalStatus(targetStatus)) {
    // Record the verified settlement evidence alongside the terminal state.
    updatePayload.metadata = {
      ...((updatePayload.metadata as Record<string, unknown> | undefined) ??
        payment.metadata ??
        {}),
      chain_evidence: {
        tx_hash: evidence.txHash,
        ledger: evidence.ledger,
        booking_id: evidence.bookingId,
        escrow_id: evidence.escrowId,
        amount_stroops: evidence.amountStroops.toString(),
        status: evidence.status,
        verified_at: new Date().toISOString(),
      },
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
      evidenceTxHash: evidence?.txHash,
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
  evidence?: VerifiedChainEvidence | null,
): Promise<Payment> {
  const result = await transitionPaymentStatus(
    paymentId,
    status,
    { txHash, status, _source: 'stellar_confirmation' },
    txHash,
    undefined,
    evidence,
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
    currency:         row.currency ?? 'USDC',
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
