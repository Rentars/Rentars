/**
 * Unit tests for cursor-based missed-record replay (issue #646).
 *
 * The recovery story depends on this being able to walk a long gap in
 * bounded work, never duplicating a record, and never silently skipping one
 * when a page fails.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRefreshCircuit, setRealtimeFetch, setSessionTokens } from '../authToken';
import { DEFAULT_MAX_RESYNC_PAGES, extractPage, resyncRecords } from '../resync';

const ENDPOINT = 'http://localhost:3000/api/v1/notifications/sync';

type MockResponse = { ok: boolean; status: number; json: () => Promise<unknown> };

function page(items: unknown[], nextCursor: string | null = null): MockResponse {
  return { ok: true, status: 200, json: async () => ({ data: items, nextCursor }) };
}

function note(id: string, created_at: string) {
  return { id, created_at, type: 'booking_confirmed' };
}

function urlOf(call: unknown[]): URL {
  return new URL(String(call[0]));
}

beforeEach(() => {
  localStorage.clear();
  resetRefreshCircuit();
  setSessionTokens('test-token');
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

// ── extractPage ───────────────────────────────────────────────────────────────

describe('extractPage', () => {
  it('reads the cursor envelope', () => {
    const { items, nextCursor } = extractPage({ data: [{ id: 'a' }], nextCursor: 'abc' });
    expect(items).toEqual([{ id: 'a' }]);
    expect(nextCursor).toBe('abc');
  });

  it('accepts the snake_case cursor variant', () => {
    const { nextCursor } = extractPage({ data: [], next_cursor: 'xyz' });
    expect(nextCursor).toBe('xyz');
  });

  it('tolerates a legacy flat array', () => {
    const { items, nextCursor } = extractPage([{ id: 'a' }]);
    expect(items).toHaveLength(1);
    expect(nextCursor).toBeNull();
  });

  it('returns an empty page for junk', () => {
    expect(extractPage(null)).toEqual({ items: [], nextCursor: null });
    expect(extractPage('nope')).toEqual({ items: [], nextCursor: null });
    expect(extractPage({ data: 'not-an-array' })).toEqual({ items: [], nextCursor: null });
  });

  it('ignores a non-string cursor', () => {
    expect(extractPage({ data: [], nextCursor: 42 }).nextCursor).toBeNull();
  });
});

// ── Basic replay ──────────────────────────────────────────────────────────────

describe('resyncRecords — single page', () => {
  it('fetches from the given high-water mark', async () => {
    const fetchMock = vi.fn().mockResolvedValue(page([note('n1', '2024-06-01T10:01:00Z')]));
    setRealtimeFetch(fetchMock as unknown as typeof fetch);

    const result = await resyncRecords({ endpoint: ENDPOINT, since: '2024-06-01T10:00:00Z' });

    expect(urlOf(fetchMock.mock.calls[0]).searchParams.get('since')).toBe('2024-06-01T10:00:00Z');
    expect(result.items).toHaveLength(1);
    expect(result.error).toBeUndefined();
  });

  it('reports the newest timestamp so the caller can advance the mark', async () => {
    setRealtimeFetch(
      vi
        .fn()
        .mockResolvedValue(
          page([note('n1', '2024-06-01T10:01:00Z'), note('n2', '2024-06-01T10:05:00Z')])
        ) as unknown as typeof fetch
    );

    const result = await resyncRecords({ endpoint: ENDPOINT, since: '2024-06-01T10:00:00Z' });

    expect(result.newestCursor).toBe('2024-06-01T10:05:00Z');
    expect(result.oldestCursor).toBe('2024-06-01T10:01:00Z');
  });

  it('authorises the request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(page([]));
    setRealtimeFetch(fetchMock as unknown as typeof fetch);

    await resyncRecords({ endpoint: ENDPOINT });

    const headers = new Headers(fetchMock.mock.calls[0][1].headers as HeadersInit);
    expect(headers.get('Authorization')).toBe('Bearer test-token');
  });

  it('omits `since` on the first call when no mark exists', async () => {
    const fetchMock = vi.fn().mockResolvedValue(page([]));
    setRealtimeFetch(fetchMock as unknown as typeof fetch);

    await resyncRecords({ endpoint: ENDPOINT });

    expect(urlOf(fetchMock.mock.calls[0]).searchParams.get('since')).toBeNull();
  });
});

// ── Multi-page cursor walking ─────────────────────────────────────────────────

describe('resyncRecords — multi-page', () => {
  it('follows cursors until the server runs out', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page([note('n1', '2024-06-01T10:01:00Z')], 'c1'))
      .mockResolvedValueOnce(page([note('n2', '2024-06-01T10:02:00Z')], 'c2'))
      .mockResolvedValueOnce(page([note('n3', '2024-06-01T10:03:00Z')], null));
    setRealtimeFetch(fetchMock as unknown as typeof fetch);

    const result = await resyncRecords({ endpoint: ENDPOINT, since: '2024-06-01T10:00:00Z' });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.items.map((i) => i.id)).toEqual(['n1', 'n2', 'n3']);
    expect(result.pages).toBe(3);
    expect(result.truncated).toBe(false);
  });

  it('passes each cursor to the next request', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page([note('n1', '2024-06-01T10:01:00Z')], 'cursor-A'))
      .mockResolvedValueOnce(page([note('n2', '2024-06-01T10:02:00Z')], null));
    setRealtimeFetch(fetchMock as unknown as typeof fetch);

    await resyncRecords({ endpoint: ENDPOINT });

    expect(urlOf(fetchMock.mock.calls[0]).searchParams.get('cursor')).toBeNull();
    expect(urlOf(fetchMock.mock.calls[1]).searchParams.get('cursor')).toBe('cursor-A');
  });

  it('returns results oldest-first regardless of page order', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page([note('n2', '2024-06-01T10:02:00Z')], 'c1'))
      .mockResolvedValueOnce(page([note('n1', '2024-06-01T10:01:00Z')], null));
    setRealtimeFetch(fetchMock as unknown as typeof fetch);

    const result = await resyncRecords({ endpoint: ENDPOINT });

    expect(result.items.map((i) => i.id)).toEqual(['n1', 'n2']);
  });

  it('deduplicates ids repeated across pages', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page([note('n1', '2024-06-01T10:01:00Z')], 'c1'))
      // The server inserted concurrently, so n1 shows up on both pages.
      .mockResolvedValueOnce(
        page([note('n1', '2024-06-01T10:01:00Z'), note('n2', '2024-06-01T10:02:00Z')], null)
      );
    setRealtimeFetch(fetchMock as unknown as typeof fetch);

    const result = await resyncRecords({ endpoint: ENDPOINT });

    expect(result.items.map((i) => i.id)).toEqual(['n1', 'n2']);
  });

  it('stops at maxPages and flags the result as truncated', async () => {
    // A server that always returns a cursor would otherwise loop forever.
    const fetchMock = vi
      .fn()
      .mockImplementation(async () =>
        page([note(`n-${Math.random()}`, '2024-06-01T10:00:00Z')], 'always-more')
      );
    setRealtimeFetch(fetchMock as unknown as typeof fetch);

    const result = await resyncRecords({ endpoint: ENDPOINT, maxPages: 3 });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.truncated).toBe(true);
    expect(result.pages).toBe(3);
  });

  it('defaults to a bounded page count', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () =>
        page([note(`n-${Math.random()}`, '2024-06-01T10:00:00Z')], 'more')
      );
    setRealtimeFetch(fetchMock as unknown as typeof fetch);

    const result = await resyncRecords({ endpoint: ENDPOINT });

    expect(result.pages).toBe(DEFAULT_MAX_RESYNC_PAGES);
    expect(fetchMock).toHaveBeenCalledTimes(DEFAULT_MAX_RESYNC_PAGES);
  });

  it('keeps the `since` mark on every page of the walk', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page([note('n1', '2024-06-01T10:01:00Z')], 'c1'))
      .mockResolvedValueOnce(page([], null));
    setRealtimeFetch(fetchMock as unknown as typeof fetch);

    await resyncRecords({ endpoint: ENDPOINT, since: 'MARK' });

    for (const call of fetchMock.mock.calls) {
      expect(urlOf(call).searchParams.get('since')).toBe('MARK');
    }
  });
});

// ── Failure handling ──────────────────────────────────────────────────────────

describe('resyncRecords — failures', () => {
  it('reports HTTP errors instead of throwing', async () => {
    setRealtimeFetch(
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({}),
      }) as unknown as typeof fetch
    );

    const result = await resyncRecords({ endpoint: ENDPOINT });

    expect(result.error).toBe('http_500');
    expect(result.items).toEqual([]);
  });

  it('reports network errors instead of throwing', async () => {
    setRealtimeFetch(vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch);

    const result = await resyncRecords({ endpoint: ENDPOINT });

    // The underlying message is preserved so logs stay diagnosable.
    expect(result.error).toBe('offline');
  });

  it('falls back to a generic code for a non-Error rejection', async () => {
    setRealtimeFetch(vi.fn().mockRejectedValue('boom') as unknown as typeof fetch);

    const result = await resyncRecords({ endpoint: ENDPOINT });
    expect(result.error).toBe('network_error');
  });

  it('reports a non-JSON body', async () => {
    setRealtimeFetch(
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('bad json');
        },
      }) as unknown as typeof fetch
    );

    const result = await resyncRecords({ endpoint: ENDPOINT });
    expect(result.error).toBe('bad_json');
  });

  it('keeps records from earlier pages when a later page fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page([note('n1', '2024-06-01T10:01:00Z')], 'c1'))
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
    setRealtimeFetch(fetchMock as unknown as typeof fetch);

    const result = await resyncRecords({ endpoint: ENDPOINT });

    // Partial progress is preserved so the caller can merge what it has.
    expect(result.items.map((i) => i.id)).toEqual(['n1']);
    expect(result.error).toBe('http_503');
  });

  it('surfaces a 401 so the caller can update the session state', async () => {
    setRealtimeFetch(
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({}),
      }) as unknown as typeof fetch
    );

    const result = await resyncRecords({ endpoint: ENDPOINT });
    expect(result.error).toBe('http_401');
  });

  it('does not advance the high-water mark past a failure', async () => {
    // The caller advances `since` from `newestCursor`; on failure that must
    // stay null so the next attempt replays the same window.
    setRealtimeFetch(
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({}),
      }) as unknown as typeof fetch
    );

    const result = await resyncRecords({ endpoint: ENDPOINT, since: 'MARK' });
    expect(result.newestCursor).toBeNull();
  });

  it('stops early when the abort signal fires', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn().mockResolvedValue(page([note('n1', '2024-06-01T10:01:00Z')]));
    setRealtimeFetch(fetchMock as unknown as typeof fetch);

    const result = await resyncRecords({ endpoint: ENDPOINT, signal: controller.signal });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.error).toBe('aborted');
  });
});

// ── Auth interaction ──────────────────────────────────────────────────────────

describe('resyncRecords — auth refresh', () => {
  it('refreshes an expired token and replays the request', async () => {
    setSessionTokens('expired', 'refresh-1');
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('/auth/refresh')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ token: 'fresh', refreshToken: 'r2' }),
        };
      }
      if (String(url).includes('/notifications/sync')) {
        return { ok: false, status: 401, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });
    setRealtimeFetch(fetchMock as unknown as typeof fetch);

    const result = await resyncRecords({ endpoint: ENDPOINT });

    // Still reports the 401 because the replay also failed, but the refresh
    // was attempted exactly once — no loop.
    expect(result.error).toBe('http_401');
    const refreshCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/auth/refresh'));
    expect(refreshCalls).toHaveLength(1);
  });

  it('still returns data when the refresh succeeds and the replay works', async () => {
    setSessionTokens('expired', 'refresh-1');
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('/auth/refresh')) {
        return { ok: true, status: 200, json: async () => ({ token: 'fresh' }) };
      }
      if (String(url).includes('/notifications/sync')) {
        // First attempt 401s, replay succeeds.
        syncCalls += 1;
        return syncCalls === 1
          ? { ok: false, status: 401, json: async () => ({}) }
          : page([note('n1', '2024-06-01T10:01:00Z')]);
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });
    setRealtimeFetch(fetchMock as unknown as typeof fetch);

    const result = await resyncRecords({ endpoint: ENDPOINT });

    expect(result.items.map((i) => i.id)).toEqual(['n1']);
  });
});

let syncCalls = 0;
beforeEach(() => {
  syncCalls = 0;
});
