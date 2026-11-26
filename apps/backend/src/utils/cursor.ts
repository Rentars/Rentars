/**
 * Cursor-based (keyset) pagination utilities.
 *
 * Cursors are opaque base64-encoded JSON payloads that encode the last-seen
 * sort key(s) so the next page can be fetched with a simple WHERE clause
 * instead of OFFSET, avoiding the performance cliff and skip/duplicate
 * problems that OFFSET pagination has under concurrent writes.
 *
 * Usage:
 *   const decoded = decodeCursor(req.query.cursor);  // { created_at, id }
 *   const nextCursor = encodeCursor({ created_at: row.created_at, id: row.id });
 */

export interface CursorPayload {
  created_at: string;
  id: string;
}

/**
 * Cursor payload for on-chain (Soroban) contract collections that are keyed by
 * a monotonically increasing u64 ID. The cursor encodes the last-seen ID so the
 * next page can be fetched with a keyset query (e.g. `id > last_id`) rather
 * than iterating the whole collection.
 *
 * `last_id` is serialized as a decimal string because JSON numbers cannot
 * represent the full u64 range without precision loss.
 */
export interface ContractCursorPayload {
  last_id: string;
}

/** Maximum number of IDs a single contract page may request. */
export const MAX_CONTRACT_PAGE_SIZE = 50;

/** Default page size for contract collection reads. */
export const DEFAULT_CONTRACT_PAGE_SIZE = 20;

const U64_MAX = (1n << 64n) - 1n;

/**
 * Encode a contract-collection cursor from the last-seen u64 ID.
 * Accepts bigint, number or decimal string; throws on invalid input so
 * callers cannot silently emit a cursor that will never decode.
 */
export function encodeContractCursor(lastId: bigint | number | string): string {
  const value = typeof lastId === 'bigint' ? lastId : BigInt(lastId);
  if (value < 0n || value > U64_MAX) {
    throw new RangeError('contract cursor last_id out of u64 range');
  }
  const payload: ContractCursorPayload = { last_id: value.toString() };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decode a contract-collection cursor back to its last-seen u64 ID.
 * Returns null if the cursor is missing, malformed, has extra/missing fields,
 * or encodes a value outside the u64 range. Strict validation mirrors
 * `decodeCursor` so only structurally exact cursors are accepted.
 */
export function decodeContractCursor(
  cursor: string | undefined | null,
): ContractCursorPayload | null {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw) as unknown;

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }

    const obj = parsed as Record<string, unknown>;
    const keys = Object.keys(obj);
    const expectedKeys: ReadonlyArray<keyof ContractCursorPayload> = ['last_id'];
    if (keys.length !== expectedKeys.length) {
      return null;
    }
    for (const key of expectedKeys) {
      if (!(key in obj)) {
        return null;
      }
    }
    for (const key of keys) {
      if (!expectedKeys.includes(key as keyof ContractCursorPayload)) {
        return null;
      }
    }

    if (typeof obj.last_id !== 'string' || !/^(0|[1-9][0-9]*)$/.test(obj.last_id)) {
      return null;
    }

    const value = BigInt(obj.last_id);
    if (value > U64_MAX) {
      return null;
    }

    return { last_id: value.toString() };
  } catch {
    return null;
  }
}

/**
 * Clamp a requested contract page size into the supported bounds so that
 * on-chain iteration never exceeds Soroban resource limits.
 */
export function clampContractPageSize(limit: number | undefined | null): number {
  if (limit === undefined || limit === null || !Number.isFinite(limit)) {
    return DEFAULT_CONTRACT_PAGE_SIZE;
  }
  const floored = Math.floor(limit);
  if (floored < 1) return 1;
  if (floored > MAX_CONTRACT_PAGE_SIZE) return MAX_CONTRACT_PAGE_SIZE;
  return floored;
}

/**
 * Build a paginated response for a contract collection ordered by ascending
 * u64 ID. `ids` must be sorted ascending and contain at most `limit + 1`
 * entries (the extra entry signals that another page exists). The returned
 * `nextCursor` is null when the collection is exhausted, guaranteeing clients
 * can page through the full history without duplicates or gaps.
 */
export function buildContractCursorPage(
  ids: ReadonlyArray<bigint | number | string>,
  limit: number,
): { data: string[]; nextCursor: string | null } {
  const pageSize = clampContractPageSize(limit);
  const normalized = ids.map((id) => (typeof id === 'bigint' ? id : BigInt(id)));
  const hasMore = normalized.length > pageSize;
  const page = hasMore ? normalized.slice(0, pageSize) : normalized;
  const last = page[page.length - 1];

  const nextCursor = hasMore && last !== undefined ? encodeContractCursor(last) : null;

  return { data: page.map((id) => id.toString()), nextCursor };
}

/**
 * Encode a cursor payload to an opaque base64 string.
 */
export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decode a cursor string back to its payload.
 * Returns null if the string is missing, malformed, missing required fields,
 * contains fields of the wrong type, or contains any extra/unexpected fields.
 *
 * Strict validation ensures only structurally exact cursors are accepted,
 * preventing malformed cursors with extra fields from bypassing query-builder
 * assumptions (see issue #482).
 */
export function decodeCursor(cursor: string | undefined | null): CursorPayload | null {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw) as unknown;

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }

    const obj = parsed as Record<string, unknown>;
    const keys = Object.keys(obj);

    // Reject if the number of keys doesn't exactly match the expected fields,
    // or if any unexpected key is present.
    const expectedKeys: ReadonlyArray<keyof CursorPayload> = ['created_at', 'id'];
    if (keys.length !== expectedKeys.length) {
      return null;
    }
    for (const key of expectedKeys) {
      if (!(key in obj)) {
        return null;
      }
    }
    for (const key of keys) {
      if (!expectedKeys.includes(key as keyof CursorPayload)) {
        return null;
      }
    }

    // Validate field types strictly.
    if (typeof obj.created_at !== 'string' || typeof obj.id !== 'string') {
      return null;
    }

    return { created_at: obj.created_at, id: obj.id };
  } catch {
    return null;
  }
}

/**
 * Build a pagination response envelope that includes the data array and
 * a nextCursor (null when no more rows exist).
 */
export function buildCursorPage<T extends { created_at?: string; id: string }>(
  rows: T[],
  limit: number,
): { data: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];

  const nextCursor =
    hasMore && last
      ? encodeCursor({ created_at: last.created_at ?? new Date().toISOString(), id: last.id })
      : null;

  return { data, nextCursor };
}
