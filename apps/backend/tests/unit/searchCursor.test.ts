/**
 * Stable, filter-bound search cursors (issue #932).
 */
import { describe, it, expect } from 'bun:test';
import {
  decodeSearchCursor,
  encodeSearchCursor,
  rowsAfterSearchCursor,
  searchCursorAfterRow,
  searchFilterFingerprint,
  validateSearchCursor,
} from '../../src/utils/searchCursor.js';

type Row = { id: string; price_per_night: number; created_at: string };

const rows: Row[] = [
  { id: 'a', price_per_night: 100, created_at: '2026-01-01T00:00:00Z' },
  { id: 'b', price_per_night: 100, created_at: '2026-01-02T00:00:00Z' },
  { id: 'c', price_per_night: 100, created_at: '2026-01-03T00:00:00Z' },
  { id: 'd', price_per_night: 200, created_at: '2026-01-04T00:00:00Z' },
];

const fingerprint = searchFilterFingerprint({ city: 'lagos', max_price: 300 });

describe('search cursors', () => {
  it('does not depend on filter key insertion order', () => {
    expect(searchFilterFingerprint({ city: 'lagos', max_price: 300 })).toBe(
      searchFilterFingerprint({ max_price: 300, city: 'lagos' }),
    );
  });

  it('encodes the sort value and unique id tie-breaker', () => {
    const cursor = searchCursorAfterRow(rows[2], 'price_asc', fingerprint)!;
    const decoded = decodeSearchCursor(cursor)!;
    expect(decoded.k).toBe(100);
    expect(decoded.id).toBe('c');
    expect(decoded.f).toBe(fingerprint);
  });

  it('rejects malformed, extra-field and old-version cursors', () => {
    expect(decodeSearchCursor('not-base64!!')).toBeNull();
    expect(decodeSearchCursor(Buffer.from('{bad', 'utf8').toString('base64url'))).toBeNull();
    expect(decodeSearchCursor(encodeSearchCursor({
      v: 1, s: 'newest', f: fingerprint, k: 'x', id: 'a', extra: true,
    } as never))).toBeNull();
    expect(decodeSearchCursor(encodeSearchCursor({
      v: 0, s: 'newest', f: fingerprint, k: 'x', id: 'a',
    }))).toBeNull();
  });

  it('rejects cursors reused with incompatible filters or sort order', () => {
    const cursor = searchCursorAfterRow(rows[1], 'price_asc', fingerprint)!;
    expect(validateSearchCursor(cursor, 'price_asc', fingerprint).ok).toBe(true);
    expect(validateSearchCursor(cursor, 'price_asc', 'different').ok).toBe(false);
    expect(validateSearchCursor(cursor, 'newest', fingerprint).ok).toBe(false);
    expect(rowsAfterSearchCursor(rows, cursor, 'price_asc', 'different').error).toBeTruthy();
  });

  it('keeps equal sort values in deterministic order without duplicates', () => {
    const page1 = rowsAfterSearchCursor(rows, null, 'price_asc', fingerprint).rows.slice(0, 2);
    const cursor = searchCursorAfterRow(page1[page1.length - 1], 'price_asc', fingerprint)!;
    const page2 = rowsAfterSearchCursor(rows, cursor, 'price_asc', fingerprint).rows.slice(0, 2);

    expect(page1.map((r) => r.id)).toEqual(['a', 'b']);
    expect(page2.map((r) => r.id)).toEqual(['c', 'd']);
    expect(new Set([...page1, ...page2].map((r) => r.id)).size).toBe(4);
    expect(rowsAfterSearchCursor(rows, cursor, 'price_asc', fingerprint).rows).toEqual(page2);
  });

  it('does not duplicate or skip items when rows change between page fetches', () => {
    const page1 = rowsAfterSearchCursor(rows, null, 'price_asc', fingerprint).rows.slice(0, 2);
    const cursor = searchCursorAfterRow(page1[page1.length - 1], 'price_asc', fingerprint)!;

    // A new listing is inserted and an existing one is updated between fetches.
    const changed = [
      ...rows.slice(0, 3),
      { id: 'x', price_per_night: 90, created_at: '2026-01-05T00:00:00Z' },
      { ...rows[3], price_per_night: 250 },
    ];
    // x sorts before the cursor, so it cannot displace or repeat page-2 items.
    const page2 = rowsAfterSearchCursor(changed, cursor, 'price_asc', fingerprint).rows;
    const ids = [...page1, ...page2].map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(page2.map((r) => r.id)).not.toContain('a');
    expect(page2.map((r) => r.id)).not.toContain('b');
  });
});
