import type { PaginatedResult } from '../types/pagination.js';

interface PaginatedQuery<T> {
  range(from: number, to: number): PromiseLike<{
    data: T[] | null;
    error: { message: string } | null;
    count: number | null;
  }>;
}

export async function executePaginatedQuery<T>(
  query: PaginatedQuery<T>,
  page: number,
  pageSize: number,
): Promise<{ result?: PaginatedResult<T>; error?: string }> {
  const from = (page - 1) * pageSize;
  const response = await query.range(from, from + pageSize - 1);

  if (response.error) return { error: response.error.message };

  const total = response.count ?? 0;
  return {
    result: {
      data: response.data ?? [],
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    },
  };
}

/**
 * Maximum number of items a single contract page may return. Chosen to stay
 * within Soroban resource limits (CPU instructions / memory) for on-chain
 * iteration over user-controlled collections.
 */
export const MAX_CONTRACT_PAGE_SIZE = 50;

/**
 * A single page of results returned by a contract page API.
 *
 * `cursor` is an opaque, stable keyset cursor pointing at the position after
 * the last item in `data`. It is `null` when there are no more pages.
 */
export interface ContractPage<T> {
  data: T[];
  cursor: string | null;
}

/**
 * Contract page API. Fetches at most `limit` items starting after `cursor`
 * (or from the beginning when `cursor` is `null`). Implementations must
 * guarantee deterministic ordering so that keyset pagination yields no
 * duplicates or gaps.
 */
export interface ContractPageQuery<T> {
  page(cursor: string | null, limit: number): PromiseLike<{
    data: T[] | null;
    cursor: string | null;
    error: { message: string } | null;
  }>;
}

export interface FetchAllContractPagesOptions {
  /** Maximum items per page. Clamped to `MAX_CONTRACT_PAGE_SIZE`. */
  pageSize?: number;
  /** Safety cap on the number of pages fetched to avoid runaway loops. */
  maxPages?: number;
}

export interface FetchAllContractPagesResult<T> {
  data: T[];
  pagesFetched: number;
}

/**
 * Iterates a contract page API using keyset cursors until exhausted,
 * accumulating the complete result set.
 *
 * Guarantees:
 * - Each request asks for at most `MAX_CONTRACT_PAGE_SIZE` items.
 * - Cursors are followed strictly forward, so no duplicates or gaps occur
 *   provided the underlying API returns deterministic ordering.
 * - A repeated or non-advancing cursor is treated as an error to prevent
 *   infinite loops.
 */
export async function fetchAllContractPages<T>(
  query: ContractPageQuery<T>,
  options: FetchAllContractPagesOptions = {},
): Promise<{ result?: FetchAllContractPagesResult<T>; error?: string }> {
  const requestedPageSize = options.pageSize ?? MAX_CONTRACT_PAGE_SIZE;
  const pageSize = Math.max(1, Math.min(requestedPageSize, MAX_CONTRACT_PAGE_SIZE));
  const maxPages = options.maxPages ?? Number.MAX_SAFE_INTEGER;

  const data: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  let pagesFetched = 0;

  while (true) {
    if (pagesFetched >= maxPages) {
      return { error: `Exceeded maximum number of pages (${maxPages})` };
    }

    const response = await query.page(cursor, pageSize);
    if (response.error) return { error: response.error.message };

    pagesFetched += 1;
    const pageData = response.data ?? [];
    data.push(...pageData);

    const nextCursor = response.cursor;
    if (nextCursor === null) break;

    if (seenCursors.has(nextCursor)) {
      return { error: 'Contract page API returned a repeated cursor' };
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  return { result: { data, pagesFetched } };
}