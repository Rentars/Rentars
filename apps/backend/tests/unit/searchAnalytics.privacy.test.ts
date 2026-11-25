/**
 * Privacy and retention tests for search analytics (issue #935).
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';

const inserted: Record<string, unknown>[] = [];
const deleted: Array<{ column: string; value: unknown }> = [];

const insertBuilder = () => ({
  select: () => ({
    single: async () => ({ data: inserted[inserted.length - 1] ?? null, error: null }),
  }),
});
const deleteBuilder = () => ({
  eq: (column: string, value: unknown) => {
    deleted.push({ column, value });
    return { error: null };
  },
  lt: (column: string, value: unknown) => {
    deleted.push({ column, value });
    return { error: null };
  },
});

const mockSupabase = {
  from: mock((table: string) => ({
    insert: (row: Record<string, unknown>) => {
      inserted.push({ table, ...row });
      return insertBuilder();
    },
    delete: deleteBuilder,
  })),
  rpc: mock(async () => ({
    data: [{ query: 'contact me at jane@example.com 09123456789', frequency: 3 }],
    error: null,
  })),
};

// Stub the Supabase client so this test exercises only our privacy logic.
mock.module('@/config/supabase.js', () => ({ supabase: mockSupabase }));

import {
  deleteSearchAnalyticsBefore,
  deleteSearchAnalyticsForUser,
  getTopQueries,
  trackSearch,
  trackSuggestionEvent,
} from '../../src/services/searchAnalytics.service.js';
import { normalizeSearchQuery, redactAnalyticsFilters } from '../../src/utils/searchMetrics.js';

describe('search analytics privacy', () => {
  beforeEach(() => {
    inserted.length = 0;
    deleted.length = 0;
  });

  it('stores anonymous, redacted searches and drops exact locations', async () => {
    await trackSearch(
      '  Jane@jexample.com 09123456789 flat ',
      4,
      'user-123',
      { city: 'Lagos', latitude: 6.52, longitude: 3.37, user_id: 'user-123', note: 'home' },
    );

    const row = inserted[0];
    expect(row.user_id).toBeNull();
    expect(String(row.query)).not.toContain('jane');
    expect(String(row.query)).not.toContain('09123456789');
    expect(row.filters).toEqual({ city: 'lagos' });
  });

  it('redacts sensitive query details and normalizes equivalent input', () => {
    expect(normalizeSearchQuery(' Lagos   FLAT ')).toBe('lagos flat');
    expect(normalizeSearchQuery('call +234 801 234 5678')).toBe('call [number]');
    expect(normalizeSearchQuery('a@b.com')).toBe('[email]');
    expect(redactAnalyticsFilters({ lat: 1, lng: 2, ip: '1.2.3.4' })).toBeUndefined();
  });

  it('supports deletion requests for legacy user-linked rows', async () => {
    const result = await deleteSearchAnalyticsForUser('user-123');
    expect(result.success).toBe(true);
    expect(deleted).toEqual([{ column: 'user_id', value: 'user-123' }]);
  });

  it('deletes rows older than the retention cutoff', async () => {
    const cutoff = new Date('2026-01-01T00:00:00.000Z');
    const result = await deleteSearchAnalyticsBefore(cutoff);
    expect(result.success).toBe(true);
    expect(deleted).toEqual([{ column: 'created_at', value: cutoff.toISOString() }]);
  });

  it('never returns raw query text from admin aggregates', async () => {
    const result = await getTopQueries('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z');
    expect(result.success).toBe(true);
    expect(result.data?.[0].query).not.toContain('jane@example.com');
    expect(result.data?.[0].query).toContain('[email]');
  });

  it('records suggestion events without user ids or raw queries', async () => {
    await trackSuggestionEvent('accepted', 'relaxed', 'jane@example.com', 'user-123');
    expect(inserted[0].user_id).toBeNull();
    expect(inserted[0].original_query).toBe('[email]');
  });
});
