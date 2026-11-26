import { randomUUID } from 'node:crypto';
import { syncAllBookings, syncAllProperties, reconcileAllPendingEscrows } from './sync.service.js';
import { purgeExpired as purgeExpiredIdempotencyKeys } from './idempotency.service.js';
import { BookingService } from './booking.service.js';
import { processDueAccountDeletions } from './privacy.service.js';
import {
  runRetentionJobs,
  type RetentionOptions,
  type RetentionRunSummary,
} from './retention.service.js';
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

const SYNC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const RECONCILIATION_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const IDEMPOTENCY_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const BOOKING_EXPIRY_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const ACCOUNT_DELETION_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const NOTIFICATION_OUTBOX_INTERVAL_MS = 60 * 1000; // 1 minute
const MAX_CONCURRENT_RECONCILIATIONS = 5;
const INITIAL_BACKOFF_MS = 1000; // 1 second
const MAX_BACKOFF_MS = 30000; // 30 seconds

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

export function startSyncScheduler(): void {
  if (process.env.NODE_ENV === 'test') return;
  // Blockchain sync
  setInterval(() => {
    runSync().catch((err) => console.error('[sync] Scheduler error:', err));
  }, SYNC_INTERVAL_MS);

  setInterval(() => {
    runEscrowReconciliation().catch((err) => console.error('[reconcile] Scheduler error:', err));
  }, RECONCILIATION_INTERVAL_MS);

  setInterval(() => {
    runNotificationOutbox().catch((err) => console.error('[notification-outbox] Scheduler error:', err));
  }, NOTIFICATION_OUTBOX_INTERVAL_MS);

  // Idempotency-key cleanup — runs once per hour, purges records older than 24 h
  setInterval(() => {
    runIdempotencyCleanup().catch((err) => console.error('[idempotency] Cleanup error:', err));
  }, IDEMPOTENCY_CLEANUP_INTERVAL_MS);

  // Booking expiry cleanup — runs every 10 minutes, expires stale Pending bookings.
  setInterval(() => {
    runBookingExpiryCleanup().catch((err) => console.error('[expiry] Scheduler error:', err));
  }, BOOKING_EXPIRY_INTERVAL_MS);

  // Account deletion — executes requests whose 7-day cancellation window has closed.
  setInterval(() => {
    processDueAccountDeletions().catch((err) => console.error('[privacy] Deletion worker error:', err));
  }, ACCOUNT_DELETION_INTERVAL_MS);

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
    `booking expiry interval: ${BOOKING_EXPIRY_INTERVAL_MS / 1000}s`,
  );
}

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

/**
 * Run one full data-retention sweep, guarding against overlapping runs so two
 * scheduled invocations can never mutate the same tables concurrently.
 *
 * This wrapper deliberately delegates all eligibility, protection (active
 * bookings, legal holds, audit/payment obligations) and batching decisions to
 * `runRetentionJobs` in retention.service.ts — the scheduler never bypasses or
 * re-implements that protection logic. It only adds overlap guarding and
 * observable logging.
 *
 * Returns the per-class summary, or null when a run was already in progress.
 */
async function runDataRetention(
  options: RetentionOptions & { label?: string } = {},
): Promise<RetentionRunSummary | null> {
  const label = options.label ?? 'scheduled';
  if (retentionRunning) {
    console.log(`[retention] Skipping ${label} — previous sweep still in progress`);
    return null;
  }

  retentionRunning = true;
  const startedAt = Date.now();
  try {
    const summary = await runRetentionJobs({
      dryRun: options.dryRun,
      batchSize: options.batchSize,
    });
    const mode = summary.dry_run ? 'Dry-run' : 'Cleanup';
    console.log(
      `[retention] ${mode} (${label}) — ` +
      `${summary.total_deleted} deleted, ${summary.total_eligible} eligible, ` +
      `${summary.total_held_skipped} held, ${summary.elapsed_ms}ms` +
      (summary.failed_classes.length ? `, failures: ${summary.failed_classes.join(',')}` : ''),
    );
    // Per-class breakdown for observability / metrics scraping.
    for (const cls of summary.classes) {
      console.log(
        `[retention] ${mode} (${label}) class=${cls.class} ` +
        `deleted=${cls.deleted} retained=${cls.retained} ` +
        `held_skipped=${cls.held_skipped} failed=${cls.failed}` +
        (cls.error ? ` error=${cls.error}` : ''),
      );
    }
    return summary;
  } catch (err) {
    // Never let a retention failure crash the scheduler; log with context so
    // operators can alert on it.
    console.error(
      `[retention] ${label} failed after ${Date.now() - startedAt}ms:`,
      err,
    );
    return null;
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
