import { syncAllBookings, syncAllProperties, reconcileAllPendingEscrows } from './sync.service.js';
import { purgeExpired as purgeExpiredIdempotencyKeys } from './idempotency.service.js';
import { BookingService } from './booking.service.js';
import { runWorkerCycle } from './notificationOutbox.service.js';

const bookingService = new BookingService();

const SYNC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const RECONCILIATION_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const IDEMPOTENCY_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const BOOKING_EXPIRY_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
/** Outbox worker polls every 30 seconds. Fast enough for near-real-time delivery
 *  without hammering the DB when the queue is idle. */
const OUTBOX_WORKER_INTERVAL_MS = 30 * 1000; // 30 seconds
const MAX_CONCURRENT_RECONCILIATIONS = 5;
const INITIAL_BACKOFF_MS = 1000; // 1 second
const MAX_BACKOFF_MS = 30000; // 30 seconds

/**
 * How often the full data-retention sweep runs.
 * Default: once every 24 hours.  Configurable via RETENTION_INTERVAL_HOURS.
 */
const RETENTION_INTERVAL_MS =
  (env.RETENTION_INTERVAL_HOURS ?? 24) * 60 * 60 * 1000;

/**
 * Delay before the startup dry-run preview fires.
 * Set short (10 s) so operators see a preview soon after boot without
 * blocking the server from accepting traffic.
 */
const RETENTION_STARTUP_PREVIEW_DELAY_MS = 10_000;

let concurrentReconciliations = 0;
let reconciliationBackoffMs = INITIAL_BACKOFF_MS;

/** Guard: prevent two full retention runs from overlapping. */
let retentionRunning = false;

async function runSync(): Promise<void> {
  const propertiesResult = await syncAllProperties();
  if (propertiesResult.success) {
    console.log(
      `[sync] Properties: ${propertiesResult.data?.synced} synced, ${propertiesResult.data?.failed} failed`,
    );
  } else {
    console.error(`[sync] Property sync failed: ${propertiesResult.error}`);
  }

  const bookingsResult = await syncAllBookings();
  if (bookingsResult.success) {
    console.log(
      `[sync] Bookings: ${bookingsResult.data?.synced} synced, ${bookingsResult.data?.failed} failed`,
    );
  } else {
    console.error(`[sync] Booking sync failed: ${bookingsResult.error}`);
  }
}

async function runEscrowReconciliation(): Promise<void> {
  if (concurrentReconciliations >= MAX_CONCURRENT_RECONCILIATIONS) {
    console.log(`[reconcile] Skipping reconciliation — max concurrency (${MAX_CONCURRENT_RECONCILIATIONS}) reached`);
    return;
  }

  concurrentReconciliations++;

  try {
    const result = await reconcileAllPendingEscrows();
    if (result.success) {
      console.log(
        `[reconcile] Escrows: ${result.data?.reconciled} reconciled, ${result.data?.failed} failed`,
      );
      reconciliationBackoffMs = INITIAL_BACKOFF_MS;
    } else {
      console.error(`[reconcile] Reconciliation failed: ${result.error}`);
      reconciliationBackoffMs = Math.min(
        reconciliationBackoffMs * 2,
        MAX_BACKOFF_MS,
      );
    }
  } catch (err) {
    console.error('[reconcile] Scheduler error:', err);
    reconciliationBackoffMs = Math.min(
      reconciliationBackoffMs * 2,
      MAX_BACKOFF_MS,
    );
  } finally {
    concurrentReconciliations--;
  }
}

export function startSyncScheduler(): void {
  // Blockchain sync
  setInterval(() => {
    runSync().catch((err) => console.error('[sync] Scheduler error:', err));
  }, SYNC_INTERVAL_MS);

  setInterval(() => {
    runEscrowReconciliation().catch((err) => console.error('[reconcile] Scheduler error:', err));
  }, RECONCILIATION_INTERVAL_MS);

  // Idempotency-key cleanup — runs once per hour, purges records older than 24 h
  setInterval(() => {
    runIdempotencyCleanup().catch((err) => console.error('[idempotency] Cleanup error:', err));
  }, IDEMPOTENCY_CLEANUP_INTERVAL_MS);

  // Booking expiry cleanup — runs every 10 minutes, expires stale Pending bookings.
  setInterval(() => {
    runBookingExpiryCleanup().catch((err) => console.error('[expiry] Scheduler error:', err));
  }, BOOKING_EXPIRY_INTERVAL_MS);

  // ── Notification outbox worker ─────────────────────────────────────────────
  //
  // Polls every 30 seconds.  Claims due rows, delivers them across channels,
  // retries on transient failures (exponential back-off), and dead-letters on
  // permanent failure.  Worker restart safety: stale 'processing' locks older
  // than 10 minutes are automatically reclaimed at the start of each cycle.
  setInterval(() => {
    runOutboxWorker().catch((err) => console.error('[outbox] Worker error:', err));
  }, OUTBOX_WORKER_INTERVAL_MS);

  // Run the outbox worker once shortly after startup to flush any rows that
  // accumulated while the server was down.
  setTimeout(() => {
    runOutboxWorker().catch((err) => console.error('[outbox] Startup flush error:', err));
  }, 15_000); // 15 seconds after boot

  // Run an initial cleanup shortly after startup so stale keys don't linger
  // across a server restart that happens to be more than 24 h after creation.
  setTimeout(() => {
    runIdempotencyCleanup().catch((err) =>
      console.error('[idempotency] Initial cleanup error:', err),
    );
    runBookingExpiryCleanup().catch((err) =>
      console.error('[expiry] Initial cleanup error:', err),
    );
  }, 30_000); // 30 seconds after startup

  // ── Data-retention cleanup ────────────────────────────────────────────────
  //
  // Scheduled sweep runs every RETENTION_INTERVAL_HOURS (default 24 h).
  // At startup a dry-run preview fires after a short delay so operators can
  // verify what the next scheduled run will touch before it mutates anything.
  //
  // To trigger an immediate live run without restarting the server, set
  // RETENTION_RUN_ON_STARTUP=true — useful for one-off cleanups after a
  // retention-policy change is deployed.

  setInterval(() => {
    runDataRetention().catch((err) => console.error('[retention] Scheduler error:', err));
  }, RETENTION_INTERVAL_MS);

  // Startup preview: dry-run only, no deletions.
  setTimeout(() => {
    runDataRetention({ dryRun: true, label: 'startup-preview' }).catch((err) =>
      console.error('[retention] Startup preview error:', err),
    );
  }, RETENTION_STARTUP_PREVIEW_DELAY_MS);

  // Optional immediate live run (e.g. after a retention-policy change).
  if (env.RETENTION_RUN_ON_STARTUP) {
    setTimeout(() => {
      runDataRetention({ dryRun: false, label: 'startup-live' }).catch((err) =>
        console.error('[retention] Startup live-run error:', err),
      );
    }, 60_000); // 60 s after startup — after the dry-run preview
  }

  console.log(
    `[sync] Scheduler started — sync interval: ${SYNC_INTERVAL_MS / 1000}s, ` +
    `reconciliation interval: ${RECONCILIATION_INTERVAL_MS / 1000}s, ` +
    `idempotency cleanup interval: ${IDEMPOTENCY_CLEANUP_INTERVAL_MS / 1000}s, ` +
    `booking expiry interval: ${BOOKING_EXPIRY_INTERVAL_MS / 1000}s, ` +
    `outbox worker interval: ${OUTBOX_WORKER_INTERVAL_MS / 1000}s`,
  );
}

async function runOutboxWorker(): Promise<void> {
  const result = await runWorkerCycle();
  if (result.success) {
    const { processed, delivered, failed, deadLettered } = result.data ?? {
      processed: 0, delivered: 0, failed: 0, deadLettered: 0,
    };
    if (processed > 0) {
      console.log(
        `[outbox] Cycle — processed: ${processed}, delivered: ${delivered}, ` +
        `failed: ${failed}, dead-lettered: ${deadLettered}`,
      );
    }
  } else {
    console.error(`[outbox] Worker cycle failed: ${result.error}`);
  }
}

async function runIdempotencyCleanup(): Promise<void> {
  const result = await purgeExpiredIdempotencyKeys();
  if (result.success) {
    if ((result.data?.deleted ?? 0) > 0) {
      console.log(`[idempotency] Purged ${result.data?.deleted} expired idempotency key(s)`);
    }
  } else {
    console.error(`[idempotency] Cleanup failed: ${result.error}`);
  }
}

async function runBookingExpiryCleanup(): Promise<void> {
  const result = await bookingService.expireStaleBookings();
  if (result.success) {
    const { expired, failed } = result.data ?? { expired: 0, failed: 0 };
    if (expired > 0 || failed > 0) {
      console.log(`[expiry] Expired ${expired} booking(s), ${failed} failure(s)`);
    }
  } else {
    console.error(`[expiry] Cleanup failed: ${result.error}`);
  }
}
