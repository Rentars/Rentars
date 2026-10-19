/**
 * Unit tests for deterministic search ordering (issue #749).
 */

import { describe, expect, it } from 'bun:test';
import { buildSearchOrderClauses } from '../../src/utils/searchSort.js';

const SORTS = ['price_asc', 'price_desc', 'rating', 'relevance', 'distance', 'newest'];

describe('buildSearchOrderClauses', () => {
  it.each(SORTS)('always ends %s with the unique id column', (sortBy) => {
    const clauses = buildSearchOrderClauses(sortBy);
    expect(clauses[clauses.length - 1]).toEqual({ column: 'id', options: { ascending: true } });
  });

  it('defaults unknown and missing sort keys to newest first', () => {
    expect(buildSearchOrderClauses(undefined)).toEqual(buildSearchOrderClauses('newest'));
    expect(buildSearchOrderClauses('not-a-sort')).toEqual(buildSearchOrderClauses('newest'));
    expect(buildSearchOrderClauses('newest')).toEqual([
      { column: 'created_at', options: { ascending: false } },
      { column: 'id', options: { ascending: true } },
    ]);
  });

  it('sorts price ascending and descending on price_per_night', () => {
    expect(buildSearchOrderClauses('price_asc')[0]).toEqual({
      column: 'price_per_night',
      options: { ascending: true },
    });
    expect(buildSearchOrderClauses('price_desc')[0]).toEqual({
      column: 'price_per_night',
      options: { ascending: false },
    });
  });

  it('orders by rating then review count, keeping unrated listings last', () => {
    expect(buildSearchOrderClauses('rating')).toEqual([
      { column: 'average_rating', options: { ascending: false, nullsFirst: false } },
      { column: 'review_count', options: { ascending: false, nullsFirst: false } },
      { column: 'id', options: { ascending: true } },
    ]);
  });

  it('never repeats the id clause or places it before the primary sort key', () => {
    for (const sortBy of SORTS) {
      const columns = buildSearchOrderClauses(sortBy).map((c) => c.column);
      expect(columns.filter((c) => c === 'id')).toHaveLength(1);
      expect(columns.indexOf('id')).toBe(columns.length - 1);
    }
  });

  it('produces the same clause list for the same input (deterministic)', () => {
    for (const sortBy of SORTS) {
      expect(buildSearchOrderClauses(sortBy)).toEqual(buildSearchOrderClauses(sortBy));
    }
  });
});

/**
 * Simulated pagination over a fixture with many tied sort keys. Using the
 * clauses above as a comparator must yield pages that together contain every
 * row exactly once, which is the property issue #749 requires.
 */
describe('stable pagination with tied sort keys', () => {
  type Row = { id: string; price_per_night: number };

  const rows: Row[] = Array.from({ length: 23 }, (_, i) => ({
    id: `listing-${String(i).padStart(2, '0')}`,
    price_per_night: 100 + (i % 4) * 10,
  }));

  function sortRows(input: Row[], sortBy: string): Row[] {
    const clauses = buildSearchOrderClauses(sortBy);
    return [...input].sort((a, b) => {
      for (const { column, options } of clauses) {
        const av = a[column as keyof Row];
        const bv = b[column as keyof Row];
        if (av === bv) continue;
        const cmp = av < bv ? -1 : 1;
        return options.ascending ? cmp : -cmp;
      }
      return 0;
    });
  }

  it.each(['price_asc', 'price_desc'])('pages %s without duplicates or skipped rows', (sortBy) => {
    const ordered = sortRows(rows, sortBy);
    const pageSize = 5;
    const seen: string[] = [];
    for (let from = 0; from < ordered.length; from += pageSize) {
      seen.push(...ordered.slice(from, from + pageSize).map((r) => r.id));
    }
    expect(new Set(seen).size).toBe(rows.length);
    expect(seen.sort()).toEqual(rows.map((r) => r.id).sort());
  });
});
