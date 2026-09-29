/**
 * Cursor-based resynchronisation of records missed while offline
 * (issue #646).
 *
 * While the realtime channel is down the client stops receiving inserts, so
 * on recovery it must back-fill everything that happened in the gap. This
 * module walks a keyset ("cursor") pagination endpoint in ascending order,
 * stopping when:
 *   - the server reports no further pages (`nextCursor === null`), or
 *   - `maxPages` is hit (bounded work per recovery), or
 *   - the caller aborts.
 *
 * Results are deduplicated by `id` and returned oldest-first so consumers can
 * merge them without re-sorting.
 */

import { authenticatedFetch } from './authToken';

export interface ResyncRecord {
  id: string;
  created_at?: string;
  [key: string]: unknown;
}

export interface ResyncOptions {
  /** Full endpoint URL, e.g. `${API_URL}/api/v1/notifications/sync`. */
  endpoint: string;
  /** Only return records strictly newer than this ISO timestamp. */
  since?: string | null;
  /** Page size (server clamps to its own maximum). */
  limit?: number;
  /** Hard cap on pages walked per recovery, so back-fill is bounded. */
  maxPages?: number;
  signal?: AbortSignal;
}

export const DEFAULT_RESYNC_LIMIT = 50;
export const DEFAULT_MAX_RESYNC_PAGES = 10;

export interface ResyncResult<T extends ResyncRecord> {
  items: T[];
  pages: number;
  /** True when `maxPages` stopped the walk before the server ran out. */
  truncated: boolean;
  /** Newest `created_at` seen — feed back in as `since` next time. */
  newestCursor: string | null;
  /** Oldest `created_at` seen, i.e. the high-water mark to resume from. */
  oldestCursor: string | null;
  error?: string;
}

/**
 * Tolerates both the cursor envelope (`{ data, nextCursor }`) and the legacy
 * flat-array response so this keeps working if the endpoint shape changes.
 */
export function extractPage(body: unknown): { items: ResyncRecord[]; nextCursor: string | null } {
  if (Array.isArray(body)) {
    return { items: body as ResyncRecord[], nextCursor: null };
  }
  if (body && typeof body === 'object') {
    const obj = body as { data?: unknown; nextCursor?: unknown; next_cursor?: unknown };
    const items = Array.isArray(obj.data) ? (obj.data as ResyncRecord[]) : [];
    const cursor =
      typeof obj.nextCursor === 'string'
        ? obj.nextCursor
        : typeof obj.next_cursor === 'string'
          ? obj.next_cursor
          : null;
    return { items, nextCursor: cursor };
  }
  return { items: [], nextCursor: null };
}

/**
 * Fetch every record created after `since`, following server cursors.
 *
 * Never throws — transport failures are reported through `error` so the
 * caller can decide whether to retry.
 */
export async function resyncRecords<T extends ResyncRecord>(
  options: ResyncOptions
): Promise<ResyncResult<T>> {
  const {
    endpoint,
    since,
    limit = DEFAULT_RESYNC_LIMIT,
    maxPages = DEFAULT_MAX_RESYNC_PAGES,
    signal,
  } = options;

  const collected: T[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;
  let newestCursor: string | null = null;
  let oldestCursor: string | null = null;
  let truncated = false;

  for (;;) {
    if (signal?.aborted) {
      return { items: collected, pages, truncated, newestCursor, oldestCursor, error: 'aborted' };
    }

    const params = new URLSearchParams({ limit: String(limit) });
    if (since) params.set('since', since);
    if (cursor) params.set('cursor', cursor);
    // The high-water mark from the previous walk, if we have one.
    if (newestCursor && !since) params.set('since', newestCursor);

    let res: Response;
    try {
      res = await authenticatedFetch(`${endpoint}?${params.toString()}`, { signal });
    } catch (err) {
      return {
        items: collected,
        pages,
        truncated,
        newestCursor,
        oldestCursor,
        error: err instanceof Error ? err.message : 'network_error',
      };
    }

    if (!res.ok) {
      return {
        items: collected,
        pages,
        truncated,
        newestCursor,
        oldestCursor,
        error: `http_${res.status}`,
      };
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { items: collected, pages, truncated, newestCursor, oldestCursor, error: 'bad_json' };
    }

    const page = extractPage(body);
    pages += 1;

    for (const item of page.items) {
      if (item?.id) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        collected.push(item as T);
      }
      if (typeof item?.created_at === 'string') {
        if (!newestCursor || item.created_at > newestCursor) newestCursor = item.created_at;
        if (!oldestCursor || item.created_at < oldestCursor) oldestCursor = item.created_at;
      }
    }

    if (!page.nextCursor) break;

    cursor = page.nextCursor;
    if (pages >= maxPages) {
      truncated = true;
      break;
    }
  }

  // Oldest-first so the consumer can append/prepend in a stable order.
  collected.sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''));

  return { items: collected, pages, truncated, newestCursor, oldestCursor };
}
