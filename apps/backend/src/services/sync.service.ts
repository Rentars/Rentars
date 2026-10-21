/**
 * sync.service.ts — blockchain ↔ Supabase reconciliation.
 *
 * #611 additions:
 *  - Retry classification: transient vs permanent failures
 *  - Bounded retry threshold (MAX_RECONCILE_ATTEMPTS) with exponential backoff
 *  - `escrow_reconcile_failed` quarantine state after exhausting retries
 *  - Tenant + host notifications on permanent failure via notification.service.ts
 *  - Deduplication: reconcile attempt counter stored in DB; no duplicate
 *    escrow actions, refunds, or notifications sent
 */

import {
  BOOKING_CONTRACT_ID,
  NETWORK_PASSPHRASE,
  PROPERTY_LISTING_CONTRACT_ID,
  STELLAR_RPC_URL,
} from '@/blockchain/config.js';
import { BookingClient } from '@/blockchain/bookingClient.js';
import { PropertyListingClient } from '@/blockchain/propertyListingClient.js';
import { getTransactionStatus } from '@/blockchain/transactionUtils.js';
import { getSorobanServer } from '@/blockchain/soroban.js';
import { supabase } from '@/config/supabase.js';
import { createNotification } from './notification.service.js';
import type { ServiceResponse } from './index.js';
import type { Booking as BookingDBRow } from '@/services/booking.service.js';

type SyncStatus = 'success' | 'failed' | 'skipped';

interface SyncLogEntry {
  entity_type: 'property' | 'booking';
  entity_id: string;
  status: SyncStatus;
  error_message?: string;
  synced_at: string;
}

async function writeSyncLog(entry: Omit<SyncLogEntry, 'synced_at'>): Promise<void> {
  await supabase.from('sync_log').insert({ ...entry, synced_at: new Date().toISOString() });
}

function buildPropertyClient(): PropertyListingClient {
  return new PropertyListingClient(PROPERTY_LISTING_CONTRACT_ID, STELLAR_RPC_URL, NETWORK_PASSPHRASE);
}

function buildBookingClient(): BookingClient {
  return new BookingClient(BOOKING_CONTRACT_ID, STELLAR_RPC_URL, NETWORK_PASSPHRASE);
}

/**
 * Sync a single property from the blockchain to Supabase.
 *
 * Reads the on-chain listing by its property ID and updates the corresponding
 * row in the properties table with the latest title, description, price, and status.
 *
 * @param propertyId - On-chain property ID (u64 as a string)
 * @returns ServiceResponse indicating success or failure
 * @throws Does not throw; errors are returned in the ServiceResponse
 */
export async function syncPropertyFromChain(
  propertyId: string,
): Promise<ServiceResponse<void>> {
  if (!PROPERTY_LISTING_CONTRACT_ID) {
    return { success: false, error: 'PROPERTY_LISTING_CONTRACT_ID is not configured' };
  }

  try {
    const client = buildPropertyClient();
    const listing = await client.getListing(BigInt(propertyId));

    const { error } = await supabase
      .from('properties')
      .update({
        title: listing.title,
        description: listing.description,
        price_per_night: Number(listing.price_per_night) / 10_000_000,
        status: listing.status.toLowerCase(),
        updated_at: new Date().toISOString(),
      })
      .eq('on_chain_id', Number(propertyId));

    if (error) {
      await writeSyncLog({ entity_type: 'property', entity_id: propertyId, status: 'failed', error_message: error.message });
      return { success: false, error: error.message };
    }

    await writeSyncLog({ entity_type: 'property', entity_id: propertyId, status: 'success' });
    return { success: true };
  } catch (err) {
    const message = (err as Error).message;
    await writeSyncLog({ entity_type: 'property', entity_id: propertyId, status: 'failed', error_message: message });
    return { success: false, error: message };
  }
}

/**
 * Sync a single booking from the blockchain to Supabase.
 *
 * @param bookingId - On-chain booking ID (u64 as a string)
 * @returns ServiceResponse indicating success or failure
 */
export async function syncBookingFromChain(
  bookingId: string,
): Promise<ServiceResponse<void>> {
  if (!BOOKING_CONTRACT_ID) {
    return { success: false, error: 'BOOKING_CONTRACT_ID is not configured' };
  }

  try {
    const client = buildBookingClient();
    const booking = await client.getBooking(BigInt(bookingId));

    const { error } = await supabase
      .from('bookings')
      .update({
        status: booking.status.toLowerCase(),
        escrow_id: booking.escrow_id || undefined,
        updated_at: new Date().toISOString(),
      })
      .eq('on_chain_id', Number(bookingId));

    if (error) {
      await writeSyncLog({ entity_type: 'booking', entity_id: bookingId, status: 'failed', error_message: error.message });
      return { success: false, error: error.message };
    }

    await writeSyncLog({ entity_type: 'booking', entity_id: bookingId, status: 'success' });
    return { success: true };
  } catch (err) {
    const message = (err as Error).message;
    await writeSyncLog({ entity_type: 'booking', entity_id: bookingId, status: 'failed', error_message: message });
    return { success: false, error: message };
  }
}

/**
 * Sync every on-chain property listing to Supabase in sequential order.
 * Iterates from ID 1 to the current listing count.
 *
 * @returns ServiceResponse with counts of synced and failed properties
 * @example
 * const result = await syncAllProperties();
 * console.log(`Synced: ${result.data.synced}, Failed: ${result.data.failed}`);
 */
export async function syncAllProperties(): Promise<ServiceResponse<{ synced: number; failed: number }>> {
  if (!PROPERTY_LISTING_CONTRACT_ID) {
    return { success: false, error: 'PROPERTY_LISTING_CONTRACT_ID is not configured' };
  }

  try {
    const client = buildPropertyClient();
    const count = await client.listingCount();

    let synced = 0;
    let failed = 0;

    for (let i = 1n; i <= count; i++) {
      const result = await syncPropertyFromChain(String(i));
      result.success ? synced++ : failed++;
    }

    return { success: true, data: { synced, failed } };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Sync every on-chain booking to Supabase in sequential order.
 * Iterates from ID 1 to the current booking count.
 *
 * @returns ServiceResponse with counts of synced and failed bookings
 */
export async function syncAllBookings(): Promise<ServiceResponse<{ synced: number; failed: number }>> {
  if (!BOOKING_CONTRACT_ID) {
    return { success: false, error: 'BOOKING_CONTRACT_ID is not configured' };
  }

  try {
    const client = buildBookingClient();
    const count = await client.bookingCount();

    let synced = 0;
    let failed = 0;

    for (let i = 1n; i <= count; i++) {
      const result = await syncBookingFromChain(String(i));
      result.success ? synced++ : failed++;
    }

    return { success: true, data: { synced, failed } };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

// ─── #611 Reconciliation constants ───────────────────────────────────────────

/** Maximum number of reconciliation attempts before quarantining the booking. */
const MAX_RECONCILE_ATTEMPTS = 5;

/**
 * Errors that indicate a transient (retryable) failure.
 * Anything not matching is classified as permanent.
 */
const TRANSIENT_ERROR_PATTERNS = [
  /network/i,
  /timeout/i,
  /econnreset/i,
  /enotfound/i,
  /503/,
  /502/,
  /rate.?limit/i,
];

/**
 * Errors we can positively identify as a confirmed, terminal on-chain outcome
 * (e.g. the contract itself rejected the transaction). Anything else that
 * isn't transient is "ambiguous" — we don't know if it's safe to retry, so
 * it goes to manual review instead of being silently treated as permanent.
 */
const PERMANENT_ERROR_PATTERNS = [
  /contract.*(reject|revert)/i,
  /invalid.*(amount|state|transition)/i,
  /unauthorized/i,
  /insufficient.*(balance|funds)/i,
];

type ErrorCategory = 'transient' | 'permanent' | 'ambiguous';

function classifyError(message: string): ErrorCategory {
  if (TRANSIENT_ERROR_PATTERNS.some((p) => p.test(message))) return 'transient';
  if (PERMANENT_ERROR_PATTERNS.some((p) => p.test(message))) return 'permanent';
  return 'ambiguous';
}

/**
 * Exponential backoff delay (ms) before the next reconciliation attempt.
 * attempt=1 -> 30s, 2 -> 60s, 3 -> 120s, 4 -> 240s, 5 -> 480s (capped).
 */
function backoffDelayMs(attempt: number): number {
  const base = 30_000;
  const capped = Math.min(attempt, 5);
  return base * 2 ** (capped - 1);
}

// ─── Blockchain log helper ────────────────────────────────────────────────────

/**
 * Write a blockchain reconciliation log entry.
 */
async function writeBlockchainLog(entry: {
  booking_id: string;
  tx_hash?: string;
  log_type: 'reconciliation' | 'error' | 'success';
  message?: string;
  on_chain_status?: string;
  error_category?: ErrorCategory;
  attempt?: number;
}): Promise<void> {
  await supabase.from('blockchain_logs').insert({
    ...entry,
    created_at: new Date().toISOString(),
  });
}

// ─── Tenant / host notification helpers ──────────────────────────────────────

/**
 * Fetch the tenant user ID for a booking.
 * Returns null if the booking or tenant cannot be resolved.
 */
async function getTenantId(bookingId: string): Promise<string | null> {
  const { data } = await supabase
    .from('bookings')
    .select('tenant_id')
    .eq('id', bookingId)
    .single();
  return (data as { tenant_id?: string } | null)?.tenant_id ?? null;
}

/**
 * Fetch the host (property owner) user ID for a booking.
 * Returns null if the booking or property cannot be resolved.
 */
async function getHostId(bookingId: string): Promise<string | null> {
  const { data } = await supabase
    .from('bookings')
    .select('properties(owner_id)')
    .eq('id', bookingId)
    .single();
  // biome-ignore lint/suspicious/noExplicitAny: raw Supabase join shape
  return (data as any)?.properties?.owner_id ?? null;
}

/**
 * Send privacy-safe notifications to tenant and host after a permanent
 * escrow failure.
 *
 * Rules:
 *  - Only fires once per booking (checked via `escrow_failure_notified_at`).
 *  - Does not include internal error details (privacy-safe payload only).
 *  - Falls through on notification errors so reconciliation state is still saved.
 */
type EscrowOutcome = 'failed' | 'manual_review' | 'recovered';

const OUTCOME_DEDUP_COLUMN: Record<EscrowOutcome, string> = {
  failed: 'escrow_failure_notified_at',
  manual_review: 'escrow_manual_review_notified_at',
  recovered: 'escrow_recovered_notified_at',
};

const OUTCOME_MESSAGES: Record<EscrowOutcome, { tenant: string; host: string }> = {
  failed: {
    tenant: 'Your booking escrow could not be confirmed after multiple attempts. Our support team has been alerted.',
    host: 'An escrow transaction for one of your bookings could not be confirmed. Support has been alerted.',
  },
  manual_review: {
    tenant: 'We need to manually verify your booking escrow. Our support team is reviewing it and will update you shortly.',
    host: 'An escrow transaction for one of your bookings needs manual verification. Support is reviewing it.',
  },
  recovered: {
    tenant: 'Good news — your booking escrow has been confirmed after a brief delay.',
    host: 'Good news — the escrow transaction for one of your bookings has been confirmed after a brief delay.',
  },
};

/**
 * Send a privacy-safe notification to tenant and host for a reconciliation
 * outcome (failed / manual_review / recovered). Deduplicated per outcome
 * type via its own `*_notified_at` column, so repeated reconcile passes
 * never re-send the same notification, but a later different outcome (e.g.
 * recovered after failed) is still delivered.
 */
async function notifyEscrowOutcome(
  bookingId: string,
  outcome: EscrowOutcome,
  attempt: number,
): Promise<void> {
  const dedupColumn = OUTCOME_DEDUP_COLUMN[outcome];

  const { data: booking } = await supabase
    .from('bookings')
    .select(`${dedupColumn}, tenant_id, property_id`)
    .eq('id', bookingId)
    .single();

  if ((booking as Record<string, string | null> | null)?.[dedupColumn]) {
    // Already notified for this outcome; skip
    return;
  }

  const tenantId = await getTenantId(bookingId);
  const hostId   = await getHostId(bookingId);

  const messages = OUTCOME_MESSAGES[outcome];
  const tasks: Promise<unknown>[] = [];

  if (tenantId) {
    tasks.push(
      createNotification(tenantId, 'system_alert', {
        bookingId,
        message: messages.tenant,
        supportLink: '/support',
        attempt,
        audience: 'tenant',
        outcome,
      }).catch((err) =>
        console.error(`[Reconcile] Failed to notify tenant ${tenantId}:`, err)
      ),
    );
  }

  if (hostId) {
    tasks.push(
      createNotification(hostId, 'system_alert', {
        bookingId,
        message: messages.host,
        supportLink: '/host/support',
        attempt,
        audience: 'host',
        outcome,
      }).catch((err) =>
        console.error(`[Reconcile] Failed to notify host ${hostId}:`, err)
      ),
    );
  }

  // Notification failures above are swallowed per-task (logged, not thrown)
  // so a transient notification-provider outage never blocks or re-triggers
  // the underlying state transition, which has already been durably saved.
  await Promise.all(tasks);

  await supabase
    .from('bookings')
    .update({ [dedupColumn]: new Date().toISOString() })
    .eq('id', bookingId);
}

// ─── Core reconcile function ──────────────────────────────────────────────────

/**
 * Reconcile a single booking with pending escrow by polling transaction status.
 *
 * Enhanced for #611:
 *  - Increments `reconcile_attempts` counter on each call.
 *  - Classifies errors as transient or permanent.
 *  - After MAX_RECONCILE_ATTEMPTS, marks booking as `escrow_reconcile_failed`
 *    and sends privacy-safe notifications to tenant and host.
 *  - Never re-sends notifications if already sent (deduplication).
 */
async function reconcilePendingEscrow(
  booking: BookingDBRow & {
    escrow_hash?: string;
    reconcile_attempts?: number;
    reconcile_provider_event_id?: string | null;
  },
): Promise<void> {
  if (!booking.escrow_hash || !booking.on_chain_id) {
    return;
  }

  const currentAttempt = (booking.reconcile_attempts ?? 0) + 1;

  // Increment attempt counter first so even a transient failure is tracked
  await supabase
    .from('bookings')
    .update({
      reconcile_attempts: currentAttempt,
      last_reconcile_at: new Date().toISOString(),
      reconcile_last_safe_state: booking.status,
    })
    .eq('id', booking.id);

  try {
    const server = getSorobanServer();
    const txStatus = await getTransactionStatus(server, booking.escrow_hash);

    // Idempotent dedup key for this provider response. The RPC response for
    // a confirmed transaction carries its ledger sequence; combined with the
    // (already unique) escrow tx hash this identifies one on-chain event.
    // If we've already durably recorded this exact event for this booking,
    // skip acting on it again — covers duplicate-event / late-confirmation
    // redelivery of a status we've already processed.
    const ledgerSeq = (txStatus.response as { ledger?: number } | undefined)?.ledger;
    const eventId = ledgerSeq != null ? `${booking.escrow_hash}:${ledgerSeq}` : undefined;
    if (eventId && eventId === booking.reconcile_provider_event_id) {
      return;
    }

    if (txStatus.status === 'pending') {
      await writeBlockchainLog({
        booking_id: booking.id,
        tx_hash: booking.escrow_hash,
        log_type: 'reconciliation',
        message: 'Transaction still pending',
        attempt: currentAttempt,
      });

      // Check if we've hit the attempt ceiling on a perpetually-pending tx —
      // we don't know why it never resolved, so this is ambiguous, not a
      // confirmed permanent failure.
      if (currentAttempt >= MAX_RECONCILE_ATTEMPTS) {
        await routeToManualReview(booking.id, booking.escrow_hash, currentAttempt, 'Exceeded max attempts while pending', eventId);
      } else {
        await scheduleNextAttempt(booking.id, currentAttempt);
      }
      return;
    }

    if (txStatus.status === 'success') {
      const wasFailing = Boolean(booking.reconcile_attempts && booking.reconcile_attempts > 1);

      await transitionBookingState(booking.id, 'confirmed', {
        reconcile_provider_event_id: eventId ?? booking.reconcile_provider_event_id ?? null,
        reconcile_next_attempt_at: null,
      });

      await writeBlockchainLog({
        booking_id: booking.id,
        tx_hash: booking.escrow_hash,
        log_type: 'success',
        message: 'Escrow transaction confirmed',
        on_chain_status: 'funded',
        attempt: currentAttempt,
      });

      // Recovered after prior retries — tell the tenant/host it resolved.
      if (wasFailing) {
        await notifyEscrowOutcome(booking.id, 'recovered', currentAttempt);
      }
      return;
    }

    if (txStatus.status === 'failed') {
      // Confirmed terminal on-chain failure — quarantine immediately.
      await quarantineBooking(booking.id, booking.escrow_hash, currentAttempt, 'On-chain transaction failed', eventId);
    }
  } catch (err) {
    const message = (err as Error).message;
    const category = classifyError(message);

    await writeBlockchainLog({
      booking_id: booking.id,
      tx_hash: booking.escrow_hash,
      log_type: 'error',
      message: `Reconciliation error: ${message}`,
      error_category: category,
      attempt: currentAttempt,
    });

    await supabase
      .from('bookings')
      .update({ reconcile_last_error_class: category })
      .eq('id', booking.id);

    if (category === 'permanent') {
      await quarantineBooking(booking.id, booking.escrow_hash, currentAttempt, message);
      return;
    }

    if (currentAttempt >= MAX_RECONCILE_ATTEMPTS) {
      // Ambiguous and retries exhausted — can't safely confirm or discard.
      await routeToManualReview(booking.id, booking.escrow_hash, currentAttempt, message);
      return;
    }

    if (category === 'ambiguous') {
      // Unknown failure mode below the retry ceiling — be conservative and
      // go to manual review rather than silently keep retrying.
      await routeToManualReview(booking.id, booking.escrow_hash, currentAttempt, message);
      return;
    }

    // Transient, below threshold: schedule a backed-off retry.
    await scheduleNextAttempt(booking.id, currentAttempt);
  }
}

/**
 * Centralized, idempotent booking state transition. All callers that move a
 * booking between reconciliation states go through here so the state change
 * and its associated durable metadata are always written together.
 */
async function transitionBookingState(
  bookingId: string,
  status: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await supabase
    .from('bookings')
    .update({
      status,
      updated_at: new Date().toISOString(),
      ...extra,
    })
    .eq('id', bookingId);
}

/**
 * Persist the next allowed reconciliation time using exponential backoff.
 */
async function scheduleNextAttempt(bookingId: string, attempt: number): Promise<void> {
  const nextAt = new Date(Date.now() + backoffDelayMs(attempt)).toISOString();
  await supabase
    .from('bookings')
    .update({ reconcile_next_attempt_at: nextAt })
    .eq('id', bookingId);
}

/**
 * Move a booking to the `escrow_reconcile_failed` quarantine state (a
 * confirmed, terminal on-chain failure) and notify participants.
 * Idempotent — safe to call multiple times.
 */
async function quarantineBooking(
  bookingId: string,
  txHash: string,
  attempt: number,
  reason: string,
  eventId?: string,
): Promise<void> {
  await transitionBookingState(bookingId, 'escrow_reconcile_failed', {
    last_reconcile_error: reason,
    reconcile_provider_event_id: eventId ?? null,
    reconcile_next_attempt_at: null,
  });

  await writeBlockchainLog({
    booking_id: bookingId,
    tx_hash: txHash,
    log_type: 'error',
    message: `Booking quarantined: ${reason}`,
    on_chain_status: 'escrow_reconcile_failed',
    attempt,
  });

  console.error(
    `[Reconcile] QUARANTINE booking=${bookingId} attempt=${attempt} reason="${reason}"`,
  );

  await notifyEscrowOutcome(bookingId, 'failed', attempt);
}

/**
 * Route a booking to manual review: used for ambiguous failures (we can't
 * tell if the underlying transaction succeeded, failed, or is still live)
 * and for retry-exhausted-but-unconfirmed cases. Distinct from
 * `escrow_reconcile_failed`, which is reserved for a confirmed on-chain
 * failure. Idempotent — safe to call multiple times.
 */
async function routeToManualReview(
  bookingId: string,
  txHash: string,
  attempt: number,
  reason: string,
  eventId?: string,
): Promise<void> {
  await transitionBookingState(bookingId, 'escrow_manual_review', {
    last_reconcile_error: reason,
    escrow_manual_review_at: new Date().toISOString(),
    reconcile_provider_event_id: eventId ?? null,
    reconcile_next_attempt_at: null,
  });

  await writeBlockchainLog({
    booking_id: bookingId,
    tx_hash: txHash,
    log_type: 'error',
    message: `Booking routed to manual review: ${reason}`,
    on_chain_status: 'escrow_manual_review',
    attempt,
  });

  console.error(
    `[Reconcile] MANUAL REVIEW booking=${bookingId} attempt=${attempt} reason="${reason}"`,
  );

  await notifyEscrowOutcome(bookingId, 'manual_review', attempt);
}

// ─── Public reconcile entry point ─────────────────────────────────────────────

/**
 * Reconcile all bookings with pending escrow transactions.
 *
 * Polls transaction status for every booking in `pending` state that has an
 * escrow hash AND has not yet exceeded MAX_RECONCILE_ATTEMPTS.
 *
 * @returns ServiceResponse with counts of reconciled bookings
 */
export async function reconcileAllPendingEscrows(): Promise<ServiceResponse<{ reconciled: number; failed: number }>> {
  if (!BOOKING_CONTRACT_ID) {
    return { success: false, error: 'BOOKING_CONTRACT_ID is not configured' };
  }

  try {
    const nowIso = new Date().toISOString();
    const { data: bookings, error } = await supabase
      .from('bookings')
      .select('*')
      .eq('status', 'pending')
      .not('escrow_hash', 'is', null)
      .lt('reconcile_attempts', MAX_RECONCILE_ATTEMPTS) // skip exhausted bookings
      .or(`reconcile_next_attempt_at.is.null,reconcile_next_attempt_at.lte.${nowIso}`); // respect backoff window

    if (error) {
      return { success: false, error: error.message };
    }

    let reconciled = 0;
    let failed = 0;

    for (const booking of bookings || []) {
      try {
        await reconcilePendingEscrow(
          booking as BookingDBRow & { escrow_hash?: string; reconcile_attempts?: number },
        );
        reconciled++;
      } catch (err) {
        failed++;
        console.error(`[reconcile] Failed to reconcile booking ${booking.id}:`, err);
      }
    }

    return { success: true, data: { reconciled, failed } };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}
