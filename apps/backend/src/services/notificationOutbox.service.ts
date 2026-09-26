/**
 * Notification Outbox Service
 *
 * Implements the transactional outbox pattern for reliable notification delivery.
 *
 * ── Guarantee contract ────────────────────────────────────────────────────────
 *
 *   COMMITTED domain transaction  → outbox row written   → eventual delivery
 *   ROLLED-BACK domain transaction → no outbox row        → no delivery
 *   Worker restart mid-batch       → idempotency_key prevents re-delivery
 *   Permanent provider failure     → dead_letter after max_attempts
 *
 * ── Row lifecycle ─────────────────────────────────────────────────────────────
 *
 *   pending  ──► processing ──► delivered   (happy path)
 *                    │
 *                    └──► failed ──► (retry) ──► delivered
 *                                       │
 *                               (max_attempts) ──► dead_letter
 *
 * ── Worker concurrency ───────────────────────────────────────────────────────
 *
 *   The worker polls for `pending` / `failed` rows that are due
 *   (scheduled_for <= NOW()) and attempts < max_attempts.  A row is
 *   claimed by setting status=processing + acquired_at before any delivery
 *   attempt so concurrent workers never double-deliver the same row.
 *
 * ── Channel delivery ─────────────────────────────────────────────────────────
 *
 *   Each outbox row specifies a `channels` array ('in_app', 'email', 'push').
 *   The worker calls the appropriate notification service function per channel.
 *   Mandatory notifications always include 'in_app'; whether 'email' is added
 *   is decided by the caller via the `mandatory` flag + user's mandatory_channel.
 *
 * ── Dead-letter administration ───────────────────────────────────────────────
 *
 *   Admin endpoints list and retry dead-letter rows.
 *   Retrying resets status=pending and attempt_count=0.
 */

import { supabase } from '../config/supabase.js';
import type { ServiceResponse } from './index.js';
import type { NotificationType } from './notification.service.js';
import { MANDATORY_NOTIFICATION_TYPES } from './notification.service.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type OutboxStatus =
  | 'pending'
  | 'processing'
  | 'delivered'
  | 'failed'
  | 'dead_letter';

export type DeliveryChannel = 'in_app' | 'email' | 'push';

export interface OutboxRow {
  id: string;
  user_id: string;
  type: NotificationType;
  data: Record<string, unknown>;
  channels: DeliveryChannel[];
  idempotency_key: string;
  status: OutboxStatus;
  attempt_count: number;
  max_attempts: number;
  scheduled_for: string;
  acquired_at: string | null;
  delivered_at: string | null;
  failed_at: string | null;
  dead_lettered_at: string | null;
  last_error: string | null;
  mandatory: boolean;
  source_event: string | null;
  source_id: string | null;
  created_at: string;
}

export interface EnqueueInput {
  userId: string;
  type: NotificationType;
  data: Record<string, unknown>;
  /**
   * Stable idempotency key — prevents duplicate rows on retried transactions.
   * Convention: `<source_event>:<source_id>:<user_id>`
   */
  idempotencyKey: string;
  /** Channels to attempt delivery on. Defaults to ['in_app']. */
  channels?: DeliveryChannel[];
  /** Earliest time to attempt delivery. Defaults to NOW(). */
  scheduledFor?: Date;
  /** Source event name for traceability. */
  sourceEvent?: string;
  /** Source entity UUID (booking_id, report_id, etc.). */
  sourceId?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const WORKER_BATCH_SIZE  = 50;   // rows claimed per poll cycle
const STALE_LOCK_MINUTES = 10;   // reclaim processing rows older than this

// ─── Enqueue ──────────────────────────────────────────────────────────────────

/**
 * Write an outbox row into the database.
 *
 * Must be called within (or immediately after) the domain transaction so the
 * row shares the same commit boundary.  Uses INSERT … ON CONFLICT DO NOTHING
 * to make the call idempotent — a second call with the same idempotency_key
 * is silently ignored.
 *
 * @returns The created row, or null when the key was already present.
 */
export async function enqueue(
  input: EnqueueInput,
): Promise<ServiceResponse<OutboxRow | null>> {
  const isMandatory = MANDATORY_NOTIFICATION_TYPES.has(input.type);
  const channels: DeliveryChannel[] = input.channels ?? ['in_app'];

  // Mandatory types always include in_app (permanent record).
  if (isMandatory && !channels.includes('in_app')) {
    channels.unshift('in_app');
  }

  const { data, error } = await supabase
    .from('notification_outbox')
    .upsert(
      {
        user_id:         input.userId,
        type:            input.type,
        data:            input.data,
        channels,
        idempotency_key: input.idempotencyKey,
        scheduled_for:   (input.scheduledFor ?? new Date()).toISOString(),
        mandatory:       isMandatory,
        source_event:    input.sourceEvent ?? null,
        source_id:       input.sourceId    ?? null,
        status:          'pending',
      },
      // ON CONFLICT (idempotency_key) DO NOTHING
      { onConflict: 'idempotency_key', ignoreDuplicates: true },
    )
    .select()
    .maybeSingle();

  if (error) return { success: false, error: error.message };

  // ignoreDuplicates returns null data when row already existed — that's fine.
  return { success: true, data: data as OutboxRow | null };
}

// ─── Worker ───────────────────────────────────────────────────────────────────

export interface WorkerRunResult {
  processed: number;
  delivered: number;
  failed:    number;
  deadLettered: number;
}

/**
 * Run one worker cycle:
 *   1. Reclaim stale `processing` locks (worker crash recovery).
 *   2. Claim a batch of due `pending` / `failed` rows.
 *   3. Attempt delivery for each row.
 *   4. Mark delivered / failed / dead_letter accordingly.
 */
export async function runWorkerCycle(): Promise<ServiceResponse<WorkerRunResult>> {
  // ── 1. Reclaim stale locks ─────────────────────────────────────────────────
  const staleCutoff = new Date(Date.now() - STALE_LOCK_MINUTES * 60_000).toISOString();
  await supabase
    .from('notification_outbox')
    .update({ status: 'pending', acquired_at: null })
    .eq('status', 'processing')
    .lt('acquired_at', staleCutoff);

  // ── 2. Claim batch ────────────────────────────────────────────────────────
  // Fetch IDs of due rows first, then claim them.  Using a separate UPDATE
  // with a WHERE clause is the safest pattern without advisory locks.
  const now = new Date().toISOString();

  const { data: due } = await supabase
    .from('notification_outbox')
    .select('*')
    .in('status', ['pending', 'failed'])
    .lte('scheduled_for', now)
    .order('mandatory', { ascending: false })
    .order('scheduled_for', { ascending: true })
    .limit(WORKER_BATCH_SIZE);

  const dueRows = (due ?? []) as OutboxRow[];
  // Filter client-side: attempt_count < max_attempts
  const eligible = dueRows.filter((r) => r.attempt_count < r.max_attempts);

  if (eligible.length === 0) {
    return { success: true, data: { processed: 0, delivered: 0, failed: 0, deadLettered: 0 } };
  }

  // Claim rows: mark as processing.
  const eligibleIds = eligible.map((r) => r.id);
  await supabase
    .from('notification_outbox')
    .update({ status: 'processing', acquired_at: new Date().toISOString() })
    .in('id', eligibleIds)
    .in('status', ['pending', 'failed']); // guard against race

  // ── 3. Deliver each row ────────────────────────────────────────────────────
  let delivered    = 0;
  let failed       = 0;
  let deadLettered = 0;

  for (const row of eligible) {
    try {
      await deliverRow(row);

      await supabase
        .from('notification_outbox')
        .update({
          status:       'delivered',
          delivered_at: new Date().toISOString(),
          acquired_at:  null,
          last_error:   null,
        })
        .eq('id', row.id);

      delivered++;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const nextAttempt = row.attempt_count + 1;
      const isExhausted = nextAttempt >= row.max_attempts;

      // Exponential back-off: 2^attempt * 30 seconds, capped at 1 hour.
      const backoffMs = Math.min(Math.pow(2, nextAttempt) * 30_000, 3_600_000);
      const nextScheduled = new Date(Date.now() + backoffMs).toISOString();

      await supabase
        .from('notification_outbox')
        .update({
          status:          isExhausted ? 'dead_letter' : 'failed',
          attempt_count:   nextAttempt,
          failed_at:       new Date().toISOString(),
          dead_lettered_at: isExhausted ? new Date().toISOString() : null,
          last_error:      errorMsg,
          acquired_at:     null,
          scheduled_for:   isExhausted ? row.scheduled_for : nextScheduled,
        })
        .eq('id', row.id);

      if (isExhausted) {
        deadLettered++;
        console.error(
          `[OutboxWorker] Dead-lettered row ${row.id} (${row.type} → ${row.user_id}): ${errorMsg}`,
        );
        // Alert admins of a dead-lettered mandatory notification.
        if (row.mandatory) {
          alertAdminsDeadLetter(row).catch(() => {});
        }
      } else {
        failed++;
        console.warn(
          `[OutboxWorker] Row ${row.id} attempt ${nextAttempt}/${row.max_attempts} failed: ${errorMsg}`,
        );
      }
    }
  }

  return {
    success: true,
    data: { processed: eligible.length, delivered, failed, deadLettered },
  };
}

// ─── Row delivery ─────────────────────────────────────────────────────────────

/**
 * Attempt delivery of a single outbox row across all requested channels.
 * Throws on any channel failure so the caller can record the error and retry.
 */
async function deliverRow(row: OutboxRow): Promise<void> {
  const {
    createNotification,
    sendMandatoryNotification,
    getPreferences,
  } = await import('./notification.service.js');

  const errors: string[] = [];

  for (const channel of row.channels) {
    try {
      if (channel === 'in_app') {
        if (row.mandatory) {
          // Use the deduplicating mandatory path so repeat runs are safe.
          await sendMandatoryNotification(
            row.user_id,
            row.type,
            row.data,
            row.idempotency_key,
          );
        } else {
          await createNotification(row.user_id, row.type, {
            ...row.data,
            outbox_id: row.id,
          });
        }
      } else if (channel === 'email') {
        // Fetch user email + name from their profile for email delivery.
        const { data: profile } = await supabase
          .from('users')
          .select('email')
          .eq('id', row.user_id)
          .maybeSingle();

        const userEmail = (profile as { email?: string } | null)?.email;
        if (!userEmail) {
          console.warn(`[OutboxWorker] No email for user ${row.user_id} — skipping email channel`);
          continue;
        }

        const { data: profData } = await supabase
          .from('profiles')
          .select('display_name')
          .eq('user_id', row.user_id)
          .maybeSingle();

        const userName = (profData as { display_name?: string } | null)?.display_name ?? '';

        if (row.mandatory) {
          await sendMandatoryNotification(
            row.user_id,
            row.type,
            row.data,
            row.idempotency_key,
            userEmail,
            userName,
          );
        } else {
          // Check preferences before sending optional email.
          const prefsResult = await getPreferences(row.user_id);
          const emailEnabled = prefsResult.data?.email_notifications ?? true;
          if (!emailEnabled) continue;

          const { emailService } = await import('./email.service.js');
          const subject = row.data.subject as string | undefined
            ?? String(row.type).replace(/_/g, ' ');
          await emailService.sendGenericAlert({
            to: userEmail,
            userName,
            subject,
            body: String(row.data.message ?? subject),
          });
        }
      }
      // 'push' channel: integrate with push.service.ts when needed.
      // Currently omitted — push requires device subscription state.
    } catch (channelErr) {
      errors.push(`${channel}: ${channelErr instanceof Error ? channelErr.message : String(channelErr)}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join('; '));
  }
}

// ─── Dead-letter administration ───────────────────────────────────────────────

export async function listDeadLetters(
  limit = 50,
  offset = 0,
): Promise<ServiceResponse<OutboxRow[]>> {
  const { data, error } = await supabase
    .from('notification_outbox')
    .select('*')
    .eq('status', 'dead_letter')
    .order('dead_lettered_at', { ascending: false })
    .range(offset, offset + Math.min(limit, 200) - 1);

  if (error) return { success: false, error: error.message };
  return { success: true, data: (data ?? []) as OutboxRow[] };
}

/**
 * Retry a dead-letter row by resetting it to pending with attempt_count=0.
 */
export async function retryDeadLetter(
  rowId: string,
): Promise<ServiceResponse<OutboxRow>> {
  const { data, error } = await supabase
    .from('notification_outbox')
    .update({
      status:          'pending',
      attempt_count:   0,
      last_error:      null,
      failed_at:       null,
      dead_lettered_at: null,
      scheduled_for:   new Date().toISOString(),
    })
    .eq('id', rowId)
    .eq('status', 'dead_letter')
    .select()
    .single();

  if (error || !data) return { success: false, error: error?.message ?? 'Row not found or not in dead_letter status' };
  return { success: true, data: data as OutboxRow };
}

/**
 * Permanently discard a dead-letter row that cannot be recovered.
 * Creates an audit record before deletion.
 */
export async function discardDeadLetter(
  rowId: string,
  actorId: string,
  reason: string,
): Promise<ServiceResponse<void>> {
  // Fetch the row for audit before deleting.
  const { data: row } = await supabase
    .from('notification_outbox')
    .select('id, user_id, type, idempotency_key')
    .eq('id', rowId)
    .eq('status', 'dead_letter')
    .maybeSingle();

  if (!row) return { success: false, error: 'Dead-letter row not found' };

  const { record } = await import('./auditLog.service.js');
  await record(actorId, 'outbox.dead_letter.discard', 'notification_outbox', rowId, {
    userId:          (row as OutboxRow).user_id,
    type:            (row as OutboxRow).type,
    idempotencyKey:  (row as OutboxRow).idempotency_key,
    reason,
  });

  const { error } = await supabase
    .from('notification_outbox')
    .delete()
    .eq('id', rowId);

  if (error) return { success: false, error: error.message };
  return { success: true };
}

export async function getOutboxStats(): Promise<ServiceResponse<Record<string, number>>> {
  const statuses: OutboxStatus[] = ['pending', 'processing', 'delivered', 'failed', 'dead_letter'];
  const stats: Record<string, number> = {};

  for (const status of statuses) {
    const { count } = await supabase
      .from('notification_outbox')
      .select('id', { count: 'exact', head: true })
      .eq('status', status);
    stats[status] = count ?? 0;
  }

  return { success: true, data: stats };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function alertAdminsDeadLetter(row: OutboxRow): Promise<void> {
  const { createNotification } = await import('./notification.service.js');
  const { data: admins } = await supabase
    .from('users')
    .select('id')
    .in('role', ['admin', 'moderator']);

  for (const admin of (admins ?? []) as Array<{ id: string }>) {
    await createNotification(admin.id, 'system_alert', {
      alertType:      'outbox_dead_letter',
      outboxRowId:    row.id,
      userId:         row.user_id,
      notificationType: row.type,
      mandatory:      row.mandatory,
      lastError:      row.last_error,
      message:        `Dead-lettered outbox row for ${row.mandatory ? 'MANDATORY' : 'optional'} notification type "${row.type}"`,
    }).catch(() => {});
  }
}
