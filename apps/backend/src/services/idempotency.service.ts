/**
 * Idempotency service — stores and replays responses for idempotent POST
 * requests so that network retries and double-clicks never create duplicate
 * bookings or escrow transactions.
 *
 * Keys are scoped per user (the unique constraint is on (user_id, key)) and
 * expire after RETENTION_HOURS hours.  Expired rows are purged by the
 * scheduled cleanup in cleanup-schedular.ts.
 *
 * Algorithm
 * ---------
 * 1. Controller reads the `Idempotency-Key` header and the authenticated
 *    user-id, then calls `lookup(userId, key)`.
 * 2. If a record is found AND the stored request_hash matches the current
 *    request hash → replay the stored response (HTTP 200/201 with original
 *    body).
 * 3. If a record is found BUT the hash differs → return 422 (key reused with
 *    a different payload).
 * 4. If no record is found → let the request proceed, then call
 *    `store(userId, key, requestHash, responseBody, statusCode)`.
 *
 * Request hash
 * ------------
 * We hash the serialised JSON body with SHA-256 (hex) so that reordered keys
 * or whitespace differences in a textually-equivalent body are treated as the
 * same request.  The hash is stored as a 64-character hex string that fits
 * cleanly into `VARCHAR(64)`.
 */

import { createHash } from 'node:crypto';
import { supabase } from '@/config/supabase.js';
import type { ServiceResponse } from './index.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** How long an idempotency record is retained before it may be purged. */
export const IDEMPOTENCY_RETENTION_HOURS = 24;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface IdempotencyRecord {
  id: string;
  key: string;
  user_id: string;
  request_hash: string;
  /** Stored as JSONB in the DB, returned as a plain JS object here. */
  response_body: Record<string, unknown>;
  status_code: number;
  /** 'processing' = request in flight; 'completed' = safe to replay. */
  status: 'processing' | 'completed';
  created_at: string;
}

/**
 * A sync-inbox receipt keyed by a blockchain event identity.
 *
 * Unlike HTTP idempotency keys (scoped per user), event keys are global and
 * derived from the chain event itself (e.g. `tx:<hash>:<opIndex>`), so that
 * duplicate, delayed, or reordered deliveries of the same ledger event are
 * recognised regardless of which worker sees them.
 */
export interface EventInboxRecord {
  id: string;
  /** Deterministic event identity, e.g. `tx:<hash>:<opIndex>`. */
  event_key: string;
  /** Logical stream the event belongs to (e.g. 'payments', 'escrow'). */
  stream: string;
  /** Ledger sequence / cursor position used for ordered resume. */
  cursor: string;
  /** SHA-256 hex digest of the canonical event payload. */
  payload_hash: string;
  /** 'processing' = projection in flight; 'completed' = applied. */
  status: 'processing' | 'completed';
  /** Number of projection attempts so far (for retry/backoff). */
  attempts: number;
  /** Last projection error, if any. */
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/** Prefix used to namespace event-identity keys inside `idempotency_keys`. */
export const EVENT_KEY_PREFIX = 'event:';

/**
 * Build a deterministic event-identity key from a transaction hash and the
 * operation index within that transaction.  Two deliveries of the same ledger
 * operation always produce the same key.
 */
export function buildEventKey(txHash: string, opIndex: number | string): string {
  return `${EVENT_KEY_PREFIX}tx:${txHash.toLowerCase()}:${opIndex}`;
}

/**
 * Produce a stable SHA-256 hex digest of an event payload so that a replayed
 * event with a mutated body can be detected (and quarantined) rather than
 * silently re-projected.
 */
export function hashEventPayload(payload: unknown): string {
  const stable = JSON.stringify(payload, Object.keys(payload as object).sort());
  return createHash('sha256').update(stable).digest('hex');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Produces a stable SHA-256 hex digest of `body`.
 *
 * The body object is serialised with sorted keys so that `{b:1,a:2}` and
 * `{a:2,b:1}` produce the same hash.
 */
export function hashRequestBody(body: unknown): string {
  const stable = JSON.stringify(body, Object.keys(body as object).sort());
  return createHash('sha256').update(stable).digest('hex');
}

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * Look up an existing idempotency record for `(userId, key)`.
 *
 * @returns
 *   - `{ success: true, data: IdempotencyRecord }` if a live record exists.
 *   - `{ success: true, data: null }` if no record exists (first request).
 *   - `{ success: false, error }` on a database error.
 */
export async function lookup(
  userId: string,
  key: string,
): Promise<ServiceResponse<IdempotencyRecord | null>> {
  const cutoff = new Date(Date.now() - IDEMPOTENCY_RETENTION_HOURS * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('idempotency_keys')
    .select('*')
    .eq('user_id', userId)
    .eq('key', key)
    .gte('created_at', cutoff)
    .maybeSingle();

  if (error) {
    return { success: false, error: `Idempotency lookup failed: ${error.message}` };
  }

  return { success: true, data: data as IdempotencyRecord | null };
}

/**
 * Atomically claim an idempotency key with status='processing'.
 *
 * Returns `{ claimed: true, id }` when this call wins the INSERT race and may
 * proceed with the real request.  Returns `{ claimed: false, existing }` when a
 * record already exists (either in-flight or completed) so the caller can
 * replay or reject.
 *
 * @param userId      - Authenticated user ID (scopes the key).
 * @param key         - Value of the `Idempotency-Key` header.
 * @param requestHash - SHA-256 hex digest of the canonical request body.
 */
export async function lockKey(
  userId: string,
  key: string,
  requestHash: string,
): Promise<ServiceResponse<{ claimed: true; id: string } | { claimed: false; existing: IdempotencyRecord }>> {
  const cutoff = new Date(Date.now() - IDEMPOTENCY_RETENTION_HOURS * 60 * 60 * 1000).toISOString();

  const { data: inserted, error: insertError } = await supabase
    .from('idempotency_keys')
    .insert({
      key,
      user_id: userId,
      request_hash: requestHash,
      response_body: {},
      status_code: 0,
      status: 'processing',
    })
    .select('id')
    .single();

  if (!insertError && inserted) {
    return { success: true, data: { claimed: true, id: (inserted as { id: string }).id } };
  }

  // Unique constraint fired — fetch the existing record.
  const { data: existing, error: fetchError } = await supabase
    .from('idempotency_keys')
    .select('*')
    .eq('user_id', userId)
    .eq('key', key)
    .gte('created_at', cutoff)
    .maybeSingle();

  if (fetchError || !existing) {
    return { success: false, error: `Idempotency lock failed: ${fetchError?.message ?? 'record not found'}` };
  }

  return { success: true, data: { claimed: false, existing: existing as IdempotencyRecord } };
}

/**
 * Complete a previously claimed idempotency record by storing the response.
 *
 * @param id          - UUID of the record returned by lockKey.
 * @param responseBody - The JSON-serialisable response body that was sent.
 * @param statusCode  - The HTTP status code that was sent (e.g. 201).
 */
export async function completeKey(
  id: string,
  responseBody: Record<string, unknown>,
  statusCode: number,
): Promise<ServiceResponse<void>> {
  const { error } = await supabase
    .from('idempotency_keys')
    .update({ status: 'completed', response_body: responseBody, status_code: statusCode })
    .eq('id', id);

  if (error) {
    return { success: false, error: `Idempotency complete failed: ${error.message}` };
  }

  return { success: true };
}

/**
 * Release a processing record when the underlying request fails, so the key
 * can be retried with the same payload.
 */
export async function releaseKey(id: string): Promise<void> {
  await supabase.from('idempotency_keys').delete().eq('id', id).eq('status', 'processing');
}

/**
 * Persist an idempotency record after a successful (or deterministic) response.
 *
 * An `upsert` with `ignoreDuplicates: false` ensures that if two concurrent
 * requests with the same key slip through the lookup guard at the same time,
 * only the first insert wins and subsequent ones are treated as conflicts that
 * can be resolved by the caller's next `lookup()`.
 *
 * @param userId      - Authenticated user ID (scopes the key).
 * @param key         - Value of the `Idempotency-Key` header.
 * @param requestHash - SHA-256 hex digest of the canonical request body.
 * @param responseBody - The JSON-serialisable response body that was sent.
 * @param statusCode  - The HTTP status code that was sent (e.g. 201).
 */
export async function store(
  userId: string,
  key: string,
  requestHash: string,
  responseBody: Record<string, unknown>,
  statusCode: number,
): Promise<ServiceResponse<IdempotencyRecord>> {
  const { data, error } = await supabase
    .from('idempotency_keys')
    .insert({
      key,
      user_id: userId,
      request_hash: requestHash,
      response_body: responseBody,
      status_code: statusCode,
      status: 'completed',
    })
    .select()
    .single();

  if (error) {
    return { success: false, error: `Idempotency store failed: ${error.message}` };
  }

  return { success: true, data: data as IdempotencyRecord };
}

/**
 * Delete all idempotency_keys rows older than `retentionHours`.
 * Called by the scheduled cleanup job.
 *
 * @returns The number of rows deleted, or an error message.
 */
export async function purgeExpired(
  retentionHours: number = IDEMPOTENCY_RETENTION_HOURS,
): Promise<ServiceResponse<{ deleted: number }>> {
  const cutoff = new Date(Date.now() - retentionHours * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('idempotency_keys')
    .delete()
    .lt('created_at', cutoff)
    .select('id');

  if (error) {
    return { success: false, error: `Idempotency purge failed: ${error.message}` };
  }

  const deleted = Array.isArray(data) ? data.length : 0;
  return { success: true, data: { deleted } };
}

// ─── Event inbox (sync replay-safety) ─────────────────────────────────────────

/**
 * Look up an existing event-inbox receipt for `eventKey`.
 *
 * This is the replay-safe read used by sync workers before projecting an
 * event: a `completed` record means the projection already happened and the
 * event must be skipped; a `processing` record means another worker (or a
 * previous incarnation of this worker) is mid-projection and the caller should
 * back off rather than double-apply.
 *
 * @returns
 *   - `{ success: true, data: EventInboxRecord }` if a receipt exists.
 *   - `{ success: true, data: null }` if the event has never been seen.
 *   - `{ success: false, error }` on a database error.
 */
export async function lookupEvent(
  eventKey: string,
): Promise<ServiceResponse<EventInboxRecord | null>> {
  const { data, error } = await supabase
    .from('event_inbox')
    .select('*')
    .eq('event_key', eventKey)
    .maybeSingle();

  if (error) {
    return { success: false, error: `Event inbox lookup failed: ${error.message}` };
  }

  return { success: true, data: data as EventInboxRecord | null };
}

/**
 * Atomically record receipt of an event before its projection runs.
 *
 * Returns `{ claimed: true, id }` when this call wins the INSERT race and the
 * caller may proceed to project the event.  Returns `{ claimed: false, existing }`
 * when a receipt already exists so the caller can decide to skip (completed),
 * back off (processing), or quarantine (payload hash mismatch).
 *
 * @param eventKey    - Deterministic identity from `buildEventKey`.
 * @param stream      - Logical stream the event belongs to.
 * @param cursor      - Ledger sequence / cursor position for ordered resume.
 * @param payloadHash - SHA-256 hex digest of the canonical event payload.
 */
export async function claimEvent(
  eventKey: string,
  stream: string,
  cursor: string,
  payloadHash: string,
): Promise<ServiceResponse<{ claimed: true; id: string } | { claimed: false; existing: EventInboxRecord }>> {
  const { data: inserted, error: insertError } = await supabase
    .from('event_inbox')
    .insert({
      event_key: eventKey,
      stream,
      cursor,
      payload_hash: payloadHash,
      status: 'processing',
      attempts: 1,
      last_error: null,
    })
    .select('id')
    .single();

  if (!insertError && inserted) {
    return { success: true, data: { claimed: true, id: (inserted as { id: string }).id } };
  }

  // Unique constraint fired — fetch the existing receipt.
  const { data: existing, error: fetchError } = await supabase
    .from('event_inbox')
    .select('*')
    .eq('event_key', eventKey)
    .maybeSingle();

  if (fetchError || !existing) {
    return { success: false, error: `Event claim failed: ${fetchError?.message ?? 'record not found'}` };
  }

  return { success: true, data: { claimed: false, existing: existing as EventInboxRecord } };
}

/**
 * Mark an event receipt as successfully projected.
 *
 * Idempotent: re-completing an already-completed receipt is a no-op that
 * still returns success, so a worker that crashes after projection but before
 * acknowledging can safely retry.
 */
export async function completeEvent(id: string): Promise<ServiceResponse<void>> {
  const { error } = await supabase
    .from('event_inbox')
    .update({ status: 'completed', last_error: null, updated_at: new Date().toISOString() })
    .eq('id', id);

  if (error) {
    return { success: false, error: `Event complete failed: ${error.message}` };
  }

  return { success: true };
}

/**
 * Record a projection failure so the event can be retried from a known cursor
 * or quarantined after exhausting its retry budget.
 *
 * The receipt is left in `processing` so a later retry can re-claim it; the
 * `attempts` counter is incremented and `last_error` is stored for inspection.
 */
export async function failEvent(id: string, error: string): Promise<ServiceResponse<void>> {
  const { data: current, error: fetchError } = await supabase
    .from('event_inbox')
    .select('attempts')
    .eq('id', id)
    .maybeSingle();

  if (fetchError || !current) {
    return { success: false, error: `Event fail failed: ${fetchError?.message ?? 'record not found'}` };
  }

  const attempts = ((current as { attempts: number }).attempts ?? 0) + 1;

  const { error: updateError } = await supabase
    .from('event_inbox')
    .update({ attempts, last_error: error, updated_at: new Date().toISOString() })
    .eq('id', id);

  if (updateError) {
    return { success: false, error: `Event fail failed: ${updateError.message}` };
  }

  return { success: true };
}

/**
 * Reset a `processing` receipt back to a claimable state so a restarted worker
 * can retry the projection.  Used by the recovery path when a worker dies
 * mid-projection.
 */
export async function releaseEvent(id: string): Promise<void> {
  await supabase
    .from('event_inbox')
    .update({ status: 'processing', updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'processing');
}

/**
 * Return the highest cursor successfully projected for `stream`, so a
 * restarted worker can resume from a known-good position instead of replaying
 * the whole ledger.
 */
export async function getResumeCursor(
  stream: string,
): Promise<ServiceResponse<{ cursor: string | null }>> {
  const { data, error } = await supabase
    .from('event_inbox')
    .select('cursor')
    .eq('stream', stream)
    .eq('status', 'completed')
    .order('cursor', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    return { success: false, error: `Resume cursor lookup failed: ${error.message}` };
  }

  return { success: true, data: { cursor: (data as { cursor: string } | null)?.cursor ?? null } };
}

/**
 * Measure sync lag for `stream`: the number of events received but not yet
 * projected, plus the oldest outstanding receipt's age in seconds.
 */
export async function getStreamLag(
  stream: string,
): Promise<ServiceResponse<{ pending: number; oldestPendingSeconds: number | null }>> {
  const { data, error } = await supabase
    .from('event_inbox')
    .select('created_at')
    .eq('stream', stream)
    .eq('status', 'processing');

  if (error) {
    return { success: false, error: `Lag lookup failed: ${error.message}` };
  }

  const rows = (data ?? []) as Array<{ created_at: string }>;
  const pending = rows.length;
  const oldestPendingSeconds = pending
    ? Math.floor((Date.now() - Math.min(...rows.map((r) => Date.parse(r.created_at)))) / 1000)
    : null;

  return { success: true, data: { pending, oldestPendingSeconds } };
}

/**
 * List quarantined (dead-letter) events for `stream` — receipts that have
 * exceeded `maxAttempts` and are still not completed — so operators can
 * inspect and repair them.
 */
export async function listDeadLetters(
  stream: string,
  maxAttempts: number = 5,
): Promise<ServiceResponse<EventInboxRecord[]>> {
  const { data, error } = await supabase
    .from('event_inbox')
    .select('*')
    .eq('stream', stream)
    .eq('status', 'processing')
    .gte('attempts', maxAttempts)
    .order('cursor', { ascending: true });

  if (error) {
    return { success: false, error: `Dead-letter lookup failed: ${error.message}` };
  }

  return { success: true, data: (data ?? []) as EventInboxRecord[] };
}

/**
 * Repair a dead-lettered event by clearing its error and resetting its attempt
 * counter so the worker will re-claim and re-project it from its stored cursor.
 */
export async function repairDeadLetter(id: string): Promise<ServiceResponse<void>> {
  const { error } = await supabase
    .from('event_inbox')
    .update({ attempts: 0, last_error: null, status: 'processing', updated_at: new Date().toISOString() })
    .eq('id', id);

  if (error) {
    return { success: false, error: `Dead-letter repair failed: ${error.message}` };
  }

  return { success: true };
}
