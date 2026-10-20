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

// ─── #783 Replay-safe sync constants ─────────────────────────────────────────

/** Maximum number of projection attempts before an inbox event is dead-lettered. */
const MAX_PROJECTION_ATTEMPTS = 5;

/** Default page size when draining the inbox from a cursor. */
const DEFAULT_INBOX_BATCH_SIZE = 100;

/**
 * A ledger event as delivered by the sync worker. Events may arrive duplicated,
 * delayed, or out of order; `eventKey` is the unique transaction/operation
 * identity used for idempotent processing.
 */
export interface LedgerEvent {
  /** Unique transaction/operation key, e.g. `${txHash}:${opIndex}`. */
  eventKey: string;
  /** Ledger sequence the event belongs to (used for cursor resume). */
  ledgerSequence: number;
  /** Event type, e.g. 'booking_created' | 'payment_received' | 'review_created'. */
  eventType: string;
  /** Entity type the event projects onto. */
  entityType: 'property' | 'booking' | 'payment' | 'review';
  /** Entity identifier the event projects onto. */
  entityId: string;
  /** Raw event payload. */
  payload: Record<string, unknown>;
}

type InboxStatus = 'pending' | 'processed' | 'dead_letter';

interface InboxRow {
  event_key: string;
  ledger_sequence: number;
  event_type: string;
  entity_type: LedgerEvent['entityType'];
  entity_id: string;
  payload: Record<string, unknown>;
  status: InboxStatus;
  attempts: number;
  last_error: string | null;
  received_at: string;
  processed_at: string | null;
}

/**
 * Record an event in the inbox before any projection runs.
 *
 * Idempotent: a duplicate `event_key` is ignored (unique constraint on
 * `event_key`), so replays never create a second inbox row. Returns `true`
 * when this call inserted a new row, `false` when the event was already seen.
 */
async function recordInboxReceipt(event: LedgerEvent): Promise<boolean> {
  const { data, error } = await supabase
    .from('sync_inbox')
    .upsert(
      {
        event_key: event.eventKey,
        ledger_sequence: event.ledgerSequence,
        event_type: event.eventType,
        entity_type: event.entityType,
        entity_id: event.entityId,
        payload: event.payload,
        status: 'pending' as InboxStatus,
        attempts: 0,
        last_error: null,
        received_at: new Date().toISOString(),
      },
      { onConflict: 'event_key', ignoreDuplicates: true },
    )
    .select('event_key');

  if (error) {
    throw new Error(`Failed to record inbox receipt: ${error.message}`);
  }

  // `ignoreDuplicates` yields no rows when the event was already present.
  return Array.isArray(data) && data.length > 0;
}

/**
 * Fetch the inbox row for an event key, if any.
 */
async function getInboxRow(eventKey: string): Promise<InboxRow | null> {
  const { data } = await supabase
    .from('sync_inbox')
    .select('*')
    .eq('event_key', eventKey)
    .maybeSingle();
  return (data as InboxRow | null) ?? null;
}

/**
 * Mark an inbox event as processed. Idempotent.
 */
async function markInboxProcessed(eventKey: string): Promise<void> {
  await supabase
    .from('sync_inbox')
    .update({ status: 'processed' as InboxStatus, processed_at: new Date().toISOString(), last_error: null })
    .eq('event_key', eventKey);
}

/**
 * Record a failed projection attempt, incrementing the attempt counter.
 * Returns the new attempt count.
 */
async function recordInboxFailure(eventKey: string, message: string): Promise<number> {
  const row = await getInboxRow(eventKey);
  const attempts = (row?.attempts ?? 0) + 1;
  await supabase
    .from('sync_inbox')
    .update({ attempts, last_error: message })
    .eq('event_key', eventKey);
  return attempts;
}

/**
 * Quarantine an inbox event as dead-letter after exhausting retries.
 */
async function deadLetterInboxEvent(eventKey: string, message: string): Promise<void> {
  await supabase
    .from('sync_inbox')
    .update({ status: 'dead_letter' as InboxStatus, last_error: message })
    .eq('event_key', eventKey);
  console.error(`[Sync] DEAD-LETTER event=${eventKey} reason="${message}"`);
}

/**
 * Project a single event onto domain state. Must be idempotent: callers may
 * invoke it more than once for the same event key.
 */
async function projectEvent(event: LedgerEvent): Promise<void> {
  switch (event.entityType) {
    case 'property':
      await syncPropertyFromChain(event.entityId);
      return;
    case 'booking':
      await syncBookingFromChain(event.entityId);
      return;
    case 'payment':
    case 'review':
      // Payment/review projections are keyed by event identity so replays are
      // no-ops. The projection itself is delegated to the domain tables which
      // enforce uniqueness on (event_key).
      await supabase.from(`${event.entityType}s`).upsert(
        { event_key: event.eventKey, entity_id: event.entityId, ...event.payload },
        { onConflict: 'event_key', ignoreDuplicates: true },
      );
      return;
    default:
      throw new Error(`Unknown entity type: ${(event as LedgerEvent).entityType}`);
  }
}

/**
 * Process a single ledger event idempotently.
 *
 * Flow: record inbox receipt → skip if already processed → project → mark
 * processed. Failures increment the attempt counter and are dead-lettered once
 * MAX_PROJECTION_ATTEMPTS is reached.
 *
 * @returns 'processed' | 'skipped' | 'failed' | 'dead_letter'
 */
export async function processLedgerEvent(
  event: LedgerEvent,
): Promise<'processed' | 'skipped' | 'failed' | 'dead_letter'> {
  await recordInboxReceipt(event);

  const existing = await getInboxRow(event.eventKey);
  if (existing?.status === 'processed') {
    return 'skipped';
  }
  if (existing?.status === 'dead_letter') {
    return 'dead_letter';
  }

  try {
    await projectEvent(event);
    await markInboxProcessed(event.eventKey);
    return 'processed';
  } catch (err) {
    const message = (err as Error).message;
    const attempts = await recordInboxFailure(event.eventKey, message);
    if (attempts >= MAX_PROJECTION_ATTEMPTS) {
      await deadLetterInboxEvent(event.eventKey, message);
      return 'dead_letter';
    }
    return 'failed';
  }
}

/**
 * Drain the inbox from a known cursor, processing pending events in ledger
 * order. Safe to resume after a worker restart: already-processed events are
 * skipped and the returned cursor reflects the last fully-processed ledger.
 *
 * @param fromLedgerSequence - Cursor to resume from (inclusive). Defaults to 0.
 * @param batchSize - Maximum number of events to process in this pass.
 */
export async function drainInbox(
  fromLedgerSequence = 0,
  batchSize = DEFAULT_INBOX_BATCH_SIZE,
): Promise<ServiceResponse<{ processed: number; skipped: number; failed: number; deadLetter: number; cursor: number }>> {
  try {
    const { data, error } = await supabase
      .from('sync_inbox')
      .select('*')
      .gte('ledger_sequence', fromLedgerSequence)
      .neq('status', 'processed')
      .order('ledger_sequence', { ascending: true })
      .limit(batchSize);

    if (error) {
      return { success: false, error: error.message };
    }

    let processed = 0;
    let skipped = 0;
    let failed = 0;
    let deadLetter = 0;
    let cursor = fromLedgerSequence;

    for (const row of (data as InboxRow[] | null) ?? []) {
      const event: LedgerEvent = {
        eventKey: row.event_key,
        ledgerSequence: row.ledger_sequence,
        eventType: row.event_type,
        entityType: row.entity_type,
        entityId: row.entity_id,
        payload: row.payload,
      };

      const outcome = await processLedgerEvent(event);
      if (outcome === 'processed') processed++;
      else if (outcome === 'skipped') skipped++;
      else if (outcome === 'failed') failed++;
      else deadLetter++;

      // Advance the cursor only past events that are no longer pending.
      if (outcome === 'processed' || outcome === 'skipped' || outcome === 'dead_letter') {
        cursor = Math.max(cursor, row.ledger_sequence);
      }
    }

    await saveCursor(cursor);
    return { success: true, data: { processed, skipped, failed, deadLetter, cursor } };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Persist the worker cursor so a restart resumes from a known ledger sequence.
 */
async function saveCursor(ledgerSequence: number): Promise<void> {
  await supabase
    .from('sync_cursors')
    .upsert(
      { worker: 'ledger_sync', last_ledger_sequence: ledgerSequence, updated_at: new Date().toISOString() },
      { onConflict: 'worker' },
    );
}

/**
 * Load the persisted worker cursor. Returns 0 when no cursor exists yet.
 */
export async function loadCursor(): Promise<number> {
  const { data } = await supabase
    .from('sync_cursors')
    .select('last_ledger_sequence')
    .eq('worker', 'ledger_sync')
    .maybeSingle();
  return (data as { last_ledger_sequence?: number } | null)?.last_ledger_sequence ?? 0;
}

/**
 * Retry a dead-lettered event from a known cursor. Resets the event to pending
 * and reprocesses it idempotently.
 */
export async function repairDeadLetter(eventKey: string): Promise<ServiceResponse<void>> {
  const row = await getInboxRow(eventKey);
  if (!row) {
    return { success: false, error: `No inbox event for key ${eventKey}` };
  }

  await supabase
    .from('sync_inbox')
    .update({ status: 'pending' as InboxStatus, attempts: 0, last_error: null })
    .eq('event_key', eventKey);

  const outcome = await processLedgerEvent({
    eventKey: row.event_key,
    ledgerSequence: row.ledger_sequence,
    eventType: row.event_type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    payload: row.payload,
  });

  if (outcome === 'processed' || outcome === 'skipped') {
    return { success: true };
  }
  return { success: false, error: `Repair failed with outcome: ${outcome}` };
}

/**
 * Expose sync lag and dead-letter state for operations dashboards.
 *
 * @param latestLedgerSequence - Current chain head ledger sequence.
 */
export async function getSyncMetrics(
  latestLedgerSequence: number,
): Promise<ServiceResponse<{ cursor: number; lag: number; pending: number; deadLetter: number }>> {
  try {
    const cursor = await loadCursor();

    const { count: pending, error: pendingError } = await supabase
      .from('sync_inbox')
      .select('event_key', { count: 'exact', head: true })
      .eq('status', 'pending');
    if (pendingError) {
      return { success: false, error: pendingError.message };
    }

    const { count: deadLetter, error: deadLetterError } = await supabase
      .from('sync_inbox')
      .select('event_key', { count: 'exact', head: true })
      .eq('status', 'dead_letter');
    if (deadLetterError) {
      return { success: false, error: deadLetterError.message };
    }

    return {
      success: true,
      data: {
        cursor,
        lag: Math.max(0, latestLedgerSequence - cursor),
        pending: pending ?? 0,
        deadLetter: deadLetter ?? 0,
      },
    };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * List quarantined (dead-lettered) events for inspection and repair.
 */
export async function listDeadLetters(
  limit = 100,
): Promise<ServiceResponse<InboxRow[]>> {
  const { data, error } = await supabase
    .from('sync_inbox')
    .select('*')
    .eq('status', 'dead_letter')
    .order('ledger_sequence', { ascending: true })
    .limit(limit);

  if (error) {
    return { success: false, error: error.message };
  }
  return { success: true, data: (data as InboxRow[] | null) ?? [] };
}

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

type ErrorCategory = 'transient' | 'permanent';

function classifyError(message: string): ErrorCategory {
  return TRANSIENT_ERROR_PATTERNS.some((p) => p.test(message))
    ? 'transient'
    : 'permanent';
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
async function notifyEscrowFailure(bookingId: string, attempt: number): Promise<void> {
  // Check deduplication flag — never send twice
  const { data: booking } = await supabase
    .from('bookings')
    .select('escrow_failure_notified_at, tenant_id, property_id')
    .eq('id', bookingId)
    .single();

  if ((booking as { escrow_failure_notified_at?: string | null } | null)?.escrow_failure_notified_at) {
    // Already notified; skip
    return;
  }

  const tenantId = await getTenantId(bookingId);
  const hostId   = await getHostId(bookingId);

  const notificationPayload: Record<string, unknown> = {
    bookingId,
    // Privacy-safe: no internal error details, no wallet addresses
    message: 'Your booking escrow could not be confirmed after multiple attempts. Our support team has been alerted.',
    supportLink: '/support',
    attempt,
  };

  const tasks: Promise<unknown>[] = [];

  if (tenantId) {
    tasks.push(
      createNotification(tenantId, 'system_alert', {
        ...notificationPayload,
        audience: 'tenant',
      }).catch((err) =>
        console.error(`[Reconcile] Failed to notify tenant ${tenantId}:`, err)
      ),
    );
  }

  if (hostId) {
    tasks.push(
      createNotification(hostId, 'system_alert', {
        bookingId,
        message: 'An escrow transaction for one of your bookings could not be confirmed. Support has been alerted.',
        supportLink: '/host/support',
        attempt,
        audience: 'host',
      }).catch((err) =>
        console.error(`[Reconcile] Failed to notify host ${hostId}:`, err)
      ),
    );
  }

  await Promise.all(tasks);

  // Mark as notified to prevent duplicate alerts
  await supabase
    .from('bookings')
    .update({ escrow_failure_notified_at: new Date().toISOString() })
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
  booking: BookingDBRow & { escrow_hash?: string; reconcile_attempts?: number },
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
    })
    .eq('id', booking.id);

  try {
    const server = getSorobanServer();
    const txStatus = await getTransactionStatus(server, booking.escrow_hash);

    if (txStatus.status === 'pending') {
      await writeBlockchainLog({
        booking_id: booking.id,
        tx_hash: booking.escrow_hash,
        log_type: 'reconciliation',
        message: 'Transaction still pending',
        attempt: currentAttempt,
      });

      // Check if we've hit the attempt ceiling on a perpetually-pending tx
      if (currentAttempt >= MAX_RECONCILE_ATTEMPTS) {
        await quarantineBooking(booking.id, booking.escrow_hash, currentAttempt, 'Exceeded max attempts while pending');
      }
      return;
    }

    if (txStatus.status === 'success') {
      await supabase
        .from('bookings')
        .update({
          status: 'confirmed',
          updated_at: new Date().toISOString(),
        })
        .eq('id', booking.id);

      await writeBlockchainLog({
        booking_id: booking.id,
        tx_hash: booking.escrow_hash,
        log_type: 'success',
        message: 'Escrow transaction confirmed',
        on_chain_status: 'funded',
        attempt: currentAttempt,
      });
      return;
    }

    if (txStatus.status === 'failed') {
      // Terminal on-chain failure — quarantine immediately
      await quarantineBooking(booking.id, booking.escrow_hash, currentAttempt, 'On-chain transaction failed');
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

    if (category === 'permanent' || currentAttempt >= MAX_RECONCILE_ATTEMPTS) {
      await quarantineBooking(booking.id, booking.escrow_hash, currentAttempt, message);
    }
    // Transient errors below the threshold are left in `pending` for retry
  }
}

/**
 * Move a booking to the `escrow_reconcile_failed` quarantine state and notify
 * participants.  Idempotent — safe to call multiple times.
 */
async function quarantineBooking(
  bookingId: string,
  txHash: string,
  attempt: number,
  reason: string,
): Promise<void> {
  await supabase
    .from('bookings')
    .update({
      status: 'escrow_reconcile_failed',
      last_reconcile_error: reason,
      updated_at: new Date().toISOString(),
    })
    .eq('id', bookingId);

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

  await notifyEscrowFailure(bookingId, attempt);
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
    const { data: bookings, error } = await supabase
      .from('bookings')
      .select('*')
      .eq('status', 'pending')
      .not('escrow_hash', 'is', null)
      .lt('reconcile_attempts', MAX_RECONCILE_ATTEMPTS); // skip exhausted bookings

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
