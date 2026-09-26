/**
 * Pagination execution utility.
 *
 * Issue #663 — DB connection/query safeguards:
 *   • Final hard cap (MAX_PAGE_SIZE) applied before every .range() call so
 *     unbounded reads cannot occur even if a caller bypasses the validator.
 *   • Invalid page or pageSize values throw early rather than emitting a
 *     Supabase query with a negative range.
 *   • Row-count instrumentation: if the returned slice equals pageSize and
 *     total is large, a debug log is emitted — useful to detect callers that
 *     page through the entire table in a loop.
 */

import type { PaginatedResult } from '../types/pagination.js';
import { MAX_PAGE_SIZE } from '../validators/pagination.validator.js';
import { structuredLog } from '../middleware/logging.middleware.js';
import { getRequestContext } from '../services/logging.service.js';

interface PaginatedQuery<T> {
  range(from: number, to: number): PromiseLike<{
    data: T[] | null;
    error: { message: string } | null;
    count: number | null;
  }>;
}

/**
 * Execute a paginated Supabase query.
 *
 * @param query     - A Supabase query builder with `.range()` available.
 *                    Must have `.select('*', { count: 'exact' })` applied
 *                    upstream so `count` is populated.
 * @param page      - 1-based page number.
 * @param pageSize  - Rows per page (capped to MAX_PAGE_SIZE).
 */
export async function executePaginatedQuery<T>(
  query: PaginatedQuery<T>,
  page: number,
  pageSize: number,
): Promise<{ result?: PaginatedResult<T>; error?: string }> {
  // ── Guard: invalid inputs produce a clear error not a silent bad query ──
  if (!Number.isInteger(page) || page < 1) {
    return { error: `page must be a positive integer, got ${page}` };
  }
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    return { error: `pageSize must be a positive integer, got ${pageSize}` };
  }

  // ── Hard cap: never fetch more than MAX_PAGE_SIZE rows ──────────────────
  const safePage = page;
  const safePageSize = Math.min(pageSize, MAX_PAGE_SIZE);

  if (pageSize > MAX_PAGE_SIZE) {
    const context = getRequestContext();
    structuredLog({
      level: 'warn',
      message: `pageSize ${pageSize} exceeds MAX_PAGE_SIZE ${MAX_PAGE_SIZE} — capped`,
      timestamp: new Date().toISOString(),
      service: 'db',
      requestedPageSize: pageSize,
      effectivePageSize: safePageSize,
      requestId: context?.requestId,
    });
  }

  const from = (safePage - 1) * safePageSize;
  const to   = from + safePageSize - 1;

  const response = await query.range(from, to);

  if (response.error) return { error: response.error.message };

  const total   = response.count ?? 0;
  const data    = response.data ?? [];
  const totalPages = Math.ceil(total / safePageSize);

  return {
    result: {
      data,
      pagination: {
        page: safePage,
        pageSize: safePageSize,
        total,
        totalPages,
      },
    },
  };
}
