import { randomUUID } from 'node:crypto';
import { syncAllBookings, syncAllProperties, reconcileAllPendingEscrows } from './sync.service.js';
import { purgeExpired as purgeExpiredIdempotencyKeys } from './idempotency.service.js';
import { BookingService } from './booking.service.js';
import { processDueAccountDeletions } from './privacy.service.js';
import { env } from '@/config/env.js';
import { structuredLog } from '@/middleware/logging.middleware.js';

// ── Shared log context ────────────────────────────────────────────────────────

const SERVICE = 'scheduler';

/** Emit a structured log line pre-filled with service + environment. */
function schedLog(
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  correlationId: string,
  extra: Record<string, unknown> = {},
): void {
  structuredLog({
    level,
    message,
    timestamp: new Date().toISOString(),
    service: SERVICE,
    environment: env.NODE_ENV,
    correlationId,
    ...extra,
  });
}

// ── Worker instances ──────────────────────────────────────────────────────────

const bookingService = new BookingService();

// ── Intervals ─────────────────────────────────────────────────────────────────

const SYNC_INTERVAL_MS                  = 60 * 60 * 1000;   // 1 hour
const RECONCILIATION_INTERVAL_MS        = 5  * 60 * 1000;   // 5 minutes
const NOTIFICATION_OUTBOX_INTERVAL_MS   = 60 * 1000;        // 1 minute
const IDEMPOTENCY_CLEANUP_INTERVAL_MS   = 60 * 60 * 1000;   // 1 hour
const BOOKING_EXPIRY_INTERVAL_MS        = 10 * 60 * 1000;   // 10 minutes
const ACCOUNT_DELETION_INTERVAL_MS      = 60 * 60 * 1000;   // 1 hour

const RETENTION_INTERVAL_MS =
  (env.RETENTION_INTERVAL_HOURS ?? 24) * 60 * 60 * 1000;

const RETENTION_STARTUP_PREVIEW_DELAY_MS = 10_000;

const MAX_CONCURRENT_RECONCILIATIONS = 5;
const INITIAL_BACKOFF_MS             = 1_000;
const MAX_BACKOFF_MS                 = 30_000;

// ── Run-once guards (prevent tick overlap within the same process) ─────────────

let concurrentReconciliations = 0;
let reconciliationBackoffMs   = INITIAL_BACKOFF_MS;
let notificationOutboxRunning = false;
let bookingExpiryRunning      = false;
let retentionRunning          = false;

// ─────────────────────────────────────────────────────────────────────────────
// Blockchain sync
// ─────────────────────────────────────────────────────────────────────────────

async function runSync(): Promise<void> {
  const correlationId = randomUUID();
  const start = Date.now();

  schedLog('info', 'blockchain sync started', correlationId, { job: 'blockchain-sync' });

  const propertiesResult = await syncAllProperties();
  if (propertiesResult.success) {
    schedLog('info', 'property sync complete', correlationId, {
      job: 'blockchain-sync',
      outcome: 'success',
      synced: propertiesResult.data?.synced,
      failed: propertiesResult.data?.failed,
    });
  } else {
    schedLog('error', 'property sync failed', correlationId, {
      job: 'blockchain-sync',
      outcome: 'failure',
      error: propertiesResult.error,
    });
  }

  const bookingsResult = await syncAllBookings();
  if (bookingsResult.success) {
    schedLog('info', 'booking sync complete', correlationId, {
      job: 'blockchain-sync',
      outcome: 'success',
      synced: bookingsResult.data?.synced,
      failed: bookingsResult.data?.failed,
      durationMs: Date.now() - start,
    });
  } else {
    schedLog('error', 'booking sync failed', correlationId, {
      job: 'blockchain-sync',
      outcome: 'failure',
      error: bookingsResult.error,
      durationMs: Date.now() - start,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Escrow reconciliation
// ─────────────────────────────────────────────────────────────────────────────

async function runEscrowReconciliation(): Promise<void> {
  if (concurrentReconciliations >= MAX_CONCURRENT_RECONCILIATIONS) {
    const correlationId = randomUUID();
    schedLog('warn', 'escrow reconciliation skipped — max concurrency reached', correlationId, {
      job: 'escrow-reconciliation',
      outcome: 'skipped',
      concurrentReconciliations,
      maxConcurrentReconciliations: MAX_CONCURRENT_RECONCILIATIONS,
    });
    return;
  }

  const correlationId = randomUUID();
  const start = Date.now();
  concurrentReconciliations++;

  schedLog('info', 'escrow reconciliation started', correlationId, {
    job: 'escrow-reconciliation',
  });

  try {
    const result = await reconcileAllPendingEscrows();
    if (result.success) {
      reconciliationBackoffMs = INITIAL_BACKOFF_MS;
      schedLog('info', 'escrow reconciliation complete', correlationId, {
        job: 'escrow-reconciliation',
        outcome: 'success',
        reconciled: result.data?.reconciled,
        failed: result.data?.failed,
        durationMs: Date.now() - start,
      });
    } else {
      reconciliationBackoffMs = Math.min(reconciliationBackoffMs * 2, MAX_BACKOFF_MS);
      schedLog('error', 'escrow reconciliation failed', correlationId, {
        job: 'escrow-reconciliation',
        outcome: 'failure',
        error: result.error,
        nextBackoffMs: reconciliationBackoffMs,
        durationMs: Date.now() - start,
      });
    }
  } catch (err) {
    reconciliationBackoffMs = Math.min(reconciliationBackoffMs * 2, MAX_BACKOFF_MS);
    schedLog('error', 'escrow reconciliation threw unexpectedly', correlationId, {
      job: 'escrow-reconciliation',
      outcome: 'failure',
      error: err instanceof Error ? err.message : String(err),
      nextBackoffMs: reconciliationBackoffMs,
      durationMs: Date.now() - start,
    });
  } finally {
    concurrentReconciliations--;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Notification outbox
// ─────────────────────────────────────────────────────────────────────────────

async function runNotificationOutbox(): Promise<void> {
  if (notificationOutboxRunning) return;
  notificationOutboxRunning = true;

  const correlationId = randomUUID();
  const start = Date.now();

  try {
    const result = await processNotificationOutbox();
    if (!result.success) {
      schedLog('error', 'notification outbox dispatch failed', correlationId, {
        job: 'notification-outbox',
        outcome: 'failure',
        error: result.error,
        durationMs: Date.now() - start,
      });
    } else {
      schedLog('info', 'notification outbox dispatched', correlationId, {
        job: 'notification-outbox',
        outcome: 'success',
        durationMs: Date.now() - start,
      });
    }
  } finally {
    notificationOutboxRunning = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency key cleanup
// ─────────────────────────────────────────────────────────────────────────────

async function runIdempotencyCleanup(): Promise<void> {
  const correlationId = randomUUID();
  const start = Date.now();

  const result = await purgeExpiredIdempotencyKeys();
  if (result.success) {
    const deleted = result.data?.deleted ?? 0;
    if (deleted > 0) {
      schedLog('info', 'idempotency keys purged', correlationId, {
        job: 'idempotency-cleanup',
        outcome: 'success',
        deleted,
        durationMs: Date.now() - start,
      });
    }
    // No log if nothing was deleted — avoids noise on quiet ticks.
  } else {
    schedLog('error', 'idempotency cleanup failed', correlationId, {
      job: 'idempotency-cleanup',
      outcome: 'failure',
      error: result.error,
      durationMs: Date.now() - start,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Booking expiry
// ─────────────────────────────────────────────────────────────────────────────

async function runBookingExpiryCleanup(): Promise<void> {
  if (bookingExpiryRunning) {
    const correlationId = randomUUID();
    schedLog('info', 'booking expiry sweep skipped — previous sweep still running', correlationId, {
      job: 'booking-expiry',
      outcome: 'skipped',
    });
    return;
  }

  bookingExpiryRunning = true;
  const correlationId = randomUUID();
  const start = Date.now();

  schedLog('info', 'booking expiry sweep started', correlationId, { job: 'booking-expiry' });

  try {
    // Warning pass
    const warnResult = await bookingService.sendExpiryWarnings();
    if (warnResult.success) {
      const { warned = 0, failed = 0 } = warnResult.data ?? {};
      if (warned > 0 || failed > 0) {
        schedLog('info', 'expiry warnings sent', correlationId, {
          job: 'booking-expiry',
          warned,
          warnFailed: failed,
        });
      }
    } else {
      schedLog('error', 'expiry warning pass failed', correlationId, {
        job: 'booking-expiry',
        outcome: 'failure',
        error: warnResult.error,
      });
    }

    // Expiry pass
    const expireResult = await bookingService.expireStaleBookings();
    if (expireResult.success) {
      const { expired = 0, failed = 0 } = expireResult.data ?? {};
      if (expired > 0 || failed > 0) {
        schedLog('info', 'stale bookings expired', correlationId, {
          job: 'booking-expiry',
          expired,
          expireFailed: failed,
        });
      }
    } else {
      schedLog('error', 'booking expiry pass failed', correlationId, {
        job: 'booking-expiry',
        outcome: 'failure',
        error: expireResult.error,
      });
    }

    // Modification expiry pass
    const modResult = await bookingService.expireStaleModifications();
    if (modResult.success) {
      const { expired = 0, failed = 0 } = modResult.data ?? {};
      if (expired > 0 || failed > 0) {
        schedLog('info', 'stale modification proposals expired', correlationId, {
          job: 'booking-expiry',
          expiredModifications: expired,
          modFailed: failed,
        });
      }
    } else {
      schedLog('error', 'modification expiry pass failed', correlationId, {
        job: 'booking-expiry',
        outcome: 'failure',
        error: modResult.error,
      });
    }

    schedLog('info', 'booking expiry sweep complete', correlationId, {
      job: 'booking-expiry',
      outcome: 'success',
      durationMs: Date.now() - start,
    });
  } finally {
    bookingExpiryRunning = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Data retention
// ─────────────────────────────────────────────────────────────────────────────

interface RetentionOptions {
  dryRun?: boolean;
  batchSize?: number;
}

async function runDataRetention(
  options: RetentionOptions & { label?: string } = {},
): Promise<void> {
  if (retentionRunning) {
    const correlationId = randomUUID();
    schedLog('info', `retention run skipped — previous sweep still running`, correlationId, {
      job: 'data-retention',
      outcome: 'skipped',
      label: options.label ?? 'scheduled',
    });
    return;
  }

  retentionRunning = true;
  const correlationId = randomUUID();
  const start = Date.now();

  schedLog('info', `data retention sweep started`, correlationId, {
    job: 'data-retention',
    label: options.label ?? 'scheduled',
    dryRun: options.dryRun ?? false,
  });

  try {
    const summary = await runRetentionJobs({
      dryRun: options.dryRun,
      batchSize: options.batchSize,
    });

    schedLog('info', `data retention sweep complete`, correlationId, {
      job: 'data-retention',
      label: options.label ?? 'scheduled',
      outcome: 'success',
      dryRun: summary.dry_run,
      totalDeleted: summary.total_deleted,
      totalEligible: summary.total_eligible,
      totalHeldSkipped: summary.total_held_skipped,
      failedClasses: summary.failed_classes,
      durationMs: Date.now() - start,
    });
  } catch (err) {
    schedLog('error', `data retention sweep threw unexpectedly`, correlationId, {
      job: 'data-retention',
      label: options.label ?? 'scheduled',
      outcome: 'failure',
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    });
  } finally {
    retentionRunning = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Scheduler startup
// ─────────────────────────────────────────────────────────────────────────────

export function startSyncScheduler(): void {
  const startupCorrelationId = randomUUID();

  // ── Recurring intervals ───────────────────────────────────────────────────

  setInterval(() => {
    runSync().catch((err) =>
      schedLog('error', 'blockchain sync interval threw', randomUUID(), {
        job: 'blockchain-sync',
        outcome: 'failure',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }, SYNC_INTERVAL_MS);

  setInterval(() => {
    runEscrowReconciliation().catch((err) =>
      schedLog('error', 'escrow reconciliation interval threw', randomUUID(), {
        job: 'escrow-reconciliation',
        outcome: 'failure',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }, RECONCILIATION_INTERVAL_MS);

  setInterval(() => {
    runNotificationOutbox().catch((err) =>
      schedLog('error', 'notification outbox interval threw', randomUUID(), {
        job: 'notification-outbox',
        outcome: 'failure',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }, NOTIFICATION_OUTBOX_INTERVAL_MS);

  setInterval(() => {
    runIdempotencyCleanup().catch((err) =>
      schedLog('error', 'idempotency cleanup interval threw', randomUUID(), {
        job: 'idempotency-cleanup',
        outcome: 'failure',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }, IDEMPOTENCY_CLEANUP_INTERVAL_MS);

  setInterval(() => {
    runBookingExpiryCleanup().catch((err) =>
      schedLog('error', 'booking expiry interval threw', randomUUID(), {
        job: 'booking-expiry',
        outcome: 'failure',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }, BOOKING_EXPIRY_INTERVAL_MS);

  setInterval(() => {
    processDueAccountDeletions().catch((err) =>
      schedLog('error', 'account deletion interval threw', randomUUID(), {
        job: 'account-deletion',
        outcome: 'failure',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }, ACCOUNT_DELETION_INTERVAL_MS);

  setInterval(() => {
    runDataRetention().catch((err) =>
      schedLog('error', 'data retention interval threw', randomUUID(), {
        job: 'data-retention',
        outcome: 'failure',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }, RETENTION_INTERVAL_MS);

  // ── Startup one-shot tasks ────────────────────────────────────────────────

  // Initial cleanup 30 s after boot so stale keys don't survive a restart.
  setTimeout(() => {
    runIdempotencyCleanup().catch((err) =>
      schedLog('error', 'idempotency initial cleanup threw', randomUUID(), {
        job: 'idempotency-cleanup',
        outcome: 'failure',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    runBookingExpiryCleanup().catch((err) =>
      schedLog('error', 'booking expiry initial cleanup threw', randomUUID(), {
        job: 'booking-expiry',
        outcome: 'failure',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }, 30_000);

  // Retention dry-run preview 10 s after startup — lets operators see what
  // the next scheduled run will touch before it mutates anything.
  setTimeout(() => {
    runDataRetention({ dryRun: true, label: 'startup-preview' }).catch((err) =>
      schedLog('error', 'retention startup preview threw', randomUUID(), {
        job: 'data-retention',
        outcome: 'failure',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }, RETENTION_STARTUP_PREVIEW_DELAY_MS);

  // Optional immediate live run after a retention-policy change.
  if (env.RETENTION_RUN_ON_STARTUP) {
    setTimeout(() => {
      runDataRetention({ dryRun: false, label: 'startup-live' }).catch((err) =>
        schedLog('error', 'retention startup live-run threw', randomUUID(), {
          job: 'data-retention',
          outcome: 'failure',
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }, 60_000);
  }

  // ── Startup confirmation log ──────────────────────────────────────────────

  schedLog('info', 'scheduler started', startupCorrelationId, {
    job: 'startup',
    outcome: 'success',
    intervals: {
      syncMs: SYNC_INTERVAL_MS,
      reconciliationMs: RECONCILIATION_INTERVAL_MS,
      notificationOutboxMs: NOTIFICATION_OUTBOX_INTERVAL_MS,
      idempotencyCleanupMs: IDEMPOTENCY_CLEANUP_INTERVAL_MS,
      bookingExpiryMs: BOOKING_EXPIRY_INTERVAL_MS,
      accountDeletionMs: ACCOUNT_DELETION_INTERVAL_MS,
      retentionMs: RETENTION_INTERVAL_MS,
    },
  });
}
