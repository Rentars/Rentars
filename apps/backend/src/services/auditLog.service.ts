/**
 * Audit log service — immutable trail of sensitive admin/moderator actions.
 *
 * Entries are append-only: this module exposes no update/delete function,
 * and no route ever calls one.
 */

import { supabase } from '../config/supabase.js';
import type { ServiceResponse } from './index.js';

export interface AuditLogEntry {
  id: string;
  actor_id: string;
  action: string;
  target_type: string;
  target_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface AuditLogFilters {
  actorId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  /** ISO timestamp — only entries created at or after this instant. */
  since?: string;
  /** ISO timestamp — only entries created at or before this instant. */
  until?: string;
  limit?: number;
  /** Opaque cursor (created_at of the last row of the previous page). */
  cursor?: string;
}

export interface AuditLogPage {
  entries: AuditLogEntry[];
  /** Cursor to pass as `cursor` for the next page, or null when exhausted. */
  nextCursor: string | null;
}

/** Hard cap on rows returned per page — prevents unbounded table scans. */
export const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 50;

/** Keys whose values are always redacted before persistence. */
const SENSITIVE_KEY_PATTERN =
  /(pass(word)?|secret|token|api[_-]?key|authorization|auth|cookie|session|credential|private[_-]?key|refresh[_-]?token|access[_-]?token)/i;

/** Keys whose values contain personal data and are redacted at write time. */
const PII_KEY_PATTERN = /(email|phone|address|ssn|social[_-]?security|dob|birth|ip([_-]?address)?|full[_-]?name)/i;

const REDACTED = '[REDACTED]';

function redactValue(value: unknown, depth: number): unknown {
  if (depth > 8) return REDACTED;
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (typeof value === 'object') return redactObject(value as Record<string, unknown>, depth + 1);
  return value;
}

function redactObject(input: Record<string, unknown>, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (SENSITIVE_KEY_PATTERN.test(key) || PII_KEY_PATTERN.test(key)) {
      out[key] = REDACTED;
    } else {
      out[key] = redactValue(value, depth);
    }
  }
  return out;
}

/**
 * Strip secrets and personal data from audit metadata before it is persisted.
 * Exported for testing; `record` always applies it.
 */
export function redactMetadata(
  metadata: Record<string, unknown> | undefined | null,
): Record<string, unknown> {
  if (!metadata) return {};
  return redactObject(metadata);
}

/**
 * Record an audit entry for a sensitive admin/moderator action.
 * Metadata is redacted at write time so secrets are never persisted.
 * Never throws — a logging failure must not block the action it describes.
 */
export async function record(
  actorId: string,
  action: string,
  targetType: string,
  targetId?: string | null,
  metadata?: Record<string, unknown>,
): Promise<ServiceResponse<AuditLogEntry>> {
  const { data, error } = await supabase
    .from('audit_logs')
    .insert({
      actor_id: actorId,
      action,
      target_type: targetType,
      target_id: targetId ?? null,
      metadata: redactMetadata(metadata),
    })
    .select()
    .single();

  if (error) {
    console.error(`[auditLog] Failed to record "${action}" on ${targetType}:`, error.message);
    return { success: false, error: error.message };
  }

  return { success: true, data: data as AuditLogEntry };
}

function isValidTimestamp(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value));
}

/**
 * List/filter audit log entries with cursor pagination. Admin-only — enforced
 * at the route layer. Requires a time range or an actor/action filter so the
 * query can use an index instead of scanning the whole table.
 */
export async function listAuditLogs(
  filters?: AuditLogFilters,
): Promise<ServiceResponse<AuditLogPage>> {
  const hasTimeRange = isValidTimestamp(filters?.since) || isValidTimestamp(filters?.until);
  const hasNarrowFilter = Boolean(filters?.actorId || filters?.action);

  if (!hasTimeRange && !hasNarrowFilter) {
    return {
      success: false,
      error: 'A time range (since/until) or an actor/action filter is required',
    };
  }

  if (filters?.since && !isValidTimestamp(filters.since)) {
    return { success: false, error: 'Invalid "since" timestamp' };
  }
  if (filters?.until && !isValidTimestamp(filters.until)) {
    return { success: false, error: 'Invalid "until" timestamp' };
  }
  if (filters?.cursor && !isValidTimestamp(filters.cursor)) {
    return { success: false, error: 'Invalid cursor' };
  }

  const limit = Math.min(Math.max(filters?.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);

  let query = supabase.from('audit_logs').select('*');

  if (filters?.actorId) query = query.eq('actor_id', filters.actorId);
  if (filters?.action) query = query.eq('action', filters.action);
  if (filters?.targetType) query = query.eq('target_type', filters.targetType);
  if (filters?.targetId) query = query.eq('target_id', filters.targetId);
  if (filters?.since) query = query.gte('created_at', filters.since);
  if (filters?.until) query = query.lte('created_at', filters.until);
  if (filters?.cursor) query = query.lt('created_at', filters.cursor);

  // Fetch one extra row to determine whether another page exists.
  const { data, error } = await query
    .order('created_at', { ascending: false })
    .limit(limit + 1);

  if (error) return { success: false, error: error.message };

  const rows = (data ?? []) as AuditLogEntry[];
  const hasMore = rows.length > limit;
  const entries = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore && entries.length > 0 ? entries[entries.length - 1].created_at : null;

  return { success: true, data: { entries, nextCursor } };
}

/**
 * Fetch a single audit entry by id. Metadata is re-redacted on read so that
 * legacy rows written before write-time redaction never leak secrets.
 */
export async function getAuditLogById(
  id: string,
): Promise<ServiceResponse<AuditLogEntry>> {
  const { data, error } = await supabase
    .from('audit_logs')
    .select('*')
    .eq('id', id)
    .single();

  if (error) return { success: false, error: error.message };
  if (!data) return { success: false, error: 'Audit log entry not found' };

  const entry = data as AuditLogEntry;
  return {
    success: true,
    data: { ...entry, metadata: redactMetadata(entry.metadata) },
  };
}
