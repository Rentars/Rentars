export interface PaginatedResult<T> {
  data: T[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

/**
 * Maximum number of items a single contract page request may return.
 * Chosen to respect Soroban transaction resource limits when iterating
 * on-chain collections (bookings, listings, reviews).
 */
export const MAX_CONTRACT_PAGE_SIZE = 50;

/**
 * Default page size used when a client does not specify one.
 */
export const DEFAULT_CONTRACT_PAGE_SIZE = 20;

/**
 * Keyset/cursor-based page request for contract collections.
 *
 * Cursor semantics are stable and deterministic: the cursor is an opaque
 * token (typically the last seen record ID) that identifies the position
 * after which the next page begins. An absent/undefined cursor requests
 * the first page. Ordering is fixed by the contract (ascending by ID) so
 * that paging yields no duplicates or gaps.
 */
export interface ContractPageRequest {
  /** Opaque cursor marking the start of the page (exclusive). */
  cursor?: string;
  /** Requested page size; clamped to MAX_CONTRACT_PAGE_SIZE. */
  pageSize?: number;
}

/**
 * Bounded page response for contract collections.
 */
export interface ContractPageResponse<T> {
  /** Items in this page, in deterministic order. */
  data: T[];
  /** Whether more items exist after this page. */
  has_more: boolean;
  /** Cursor to pass to fetch the next page; null when no more items. */
  next_cursor: string | null;
  /** Effective page size applied to this response. */
  pageSize: number;
}

/**
 * Normalizes a requested page size into the allowed range.
 */
export function normalizeContractPageSize(pageSize?: number): number {
  if (pageSize === undefined || pageSize === null || Number.isNaN(pageSize)) {
    return DEFAULT_CONTRACT_PAGE_SIZE;
  }
  const floored = Math.floor(pageSize);
  if (floored < 1) {
    return 1;
  }
  if (floored > MAX_CONTRACT_PAGE_SIZE) {
    return MAX_CONTRACT_PAGE_SIZE;
  }
  return floored;
}