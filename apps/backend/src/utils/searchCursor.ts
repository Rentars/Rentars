/**
 * Versioned, filter-bound cursors for search pagination (issue #932).
 *
 * A cursor encodes the ordered sort key plus the unique listing id, so equal
 * sort values still have a total order. It is bound to a fingerprint of the
 * normalized filters and sort mode; a cursor from a different query (or an old
 * version) is rejected instead of silently returning wrong pages.
 */
import { createHash } from 'node:crypto';
import { buildSearchOrderClauses, compareSearchRows } from './searchSort.js';

export const SEARCH_CURSOR_VERSION = 1;

export interface SearchCursorPayload {
  v: number;
  s: string;
  f: string;
  k: string | number | null;
  id: string;
}

/** Stable fingerprint for a filter snapshot (key order must not matter). */
export function searchFilterFingerprint(filters: Record<string, unknown>): string {
  const stable = JSON.stringify(filters, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort())
      : value,
  );
  return createHash('sha256').update(stable).digest('hex').slice(0, 16);
}

export function encodeSearchCursor(payload: SearchCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** Returns null for missing, malformed, extra-field or unsupported-version cursors. */
export function decodeSearchCursor(
  cursor: string | undefined | null,
): SearchCursorPayload | null {
  if (!cursor || typeof cursor !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    const expected = ['v', 's', 'f', 'k', 'id'];
    if (Object.keys(obj).length !== expected.length || !expected.every((k) => k in obj)) return null;
    if (obj.v !== SEARCH_CURSOR_VERSION) return null;
    if (typeof obj.s !== 'string' || typeof obj.f !== 'string' || typeof obj.id !== 'string') return null;
    if (obj.k !== null && typeof obj.k !== 'string' && typeof obj.k !== 'number') return null;
    if (typeof obj.k === 'number' && !Number.isFinite(obj.k)) return null;
    return { v: SEARCH_CURSOR_VERSION, s: obj.s, f: obj.f, k: obj.k as string | number | null, id: obj.id };
  } catch {
    return null;
  }
}

/** Build the next-page cursor from the last row of a page. */
export function searchCursorAfterRow<T extends Record<string, unknown>>(
  row: T,
  sortBy: string | undefined,
  fingerprint: string,
): string | null {
  const sort = sortBy || 'newest';
  const clauses = buildSearchOrderClauses(sort);
  const key = clauses[0].column;
  const value = row[key];
  if (row.id == null) return null;
  if (value != null && typeof value !== 'string' && typeof value !== 'number') return null;
  return encodeSearchCursor({
    v: SEARCH_CURSOR_VERSION,
    s: sort,
    f: fingerprint,
    k: (value as string | number | null) ?? null,
    id: String(row.id),
  });
}

export type CursorValidation =
  | { ok: true; value: SearchCursorPayload | null }
  | { ok: false; error: string };

/** Validate a cursor against the current filter snapshot and sort mode. */
export function validateSearchCursor(
  cursor: string | undefined | null,
  sortBy: string | undefined,
  fingerprint: string,
): CursorValidation {
  if (!cursor) return { ok: true, value: null };
  const decoded = decodeSearchCursor(cursor);
  if (!decoded) return { ok: false, error: 'Invalid or unsupported cursor' };
  if (decoded.f !== fingerprint) return { ok: false, error: 'Cursor does not match the current filters' };
  if (decoded.s !== (sortBy || 'newest')) return { ok: false, error: 'Cursor does not match the current sort order' };
  return { ok: true, value: decoded };
}

/** Apply a validated cursor to an ordered snapshot of rows (no duplicate ids). */
export function rowsAfterSearchCursor<T extends Record<string, unknown>>(
  rows: readonly T[],
  cursor: string | undefined | null,
  sortBy: string | undefined,
  fingerprint: string,
): { rows: T[]; error?: string } {
  const clauses = buildSearchOrderClauses(sortBy);
  const ordered = [...rows].sort((a, b) => compareSearchRows(a, b, clauses));
  if (!cursor) return { rows: ordered };

  const decoded = decodeSearchCursor(cursor);
  if (!decoded) return { rows: [], error: 'Invalid or unsupported cursor' };
  if (decoded.f !== fingerprint) return { rows: [], error: 'Cursor does not match the current filters' };
  if (decoded.s !== (sortBy || 'newest')) return { rows: [], error: 'Cursor does not match the current sort order' };

  const anchor = { [clauses[0].column]: decoded.k, id: decoded.id } as T;
  return { rows: ordered.filter((row) => compareSearchRows(row, anchor, clauses) > 0) };
}
