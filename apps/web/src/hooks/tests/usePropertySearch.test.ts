import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePropertySearch } from '../usePropertySearch';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const beachHouse = { id: 'p1', title: 'Beach House' };
const staleCabin = { id: 'p0', title: 'Stale Cabin' };

beforeEach(() => {
  mockFetch.mockReset();
});

describe('usePropertySearch', () => {
  it('initializes with empty results and no loading', () => {
    const { result } = renderHook(() => usePropertySearch());

    expect(result.current.results).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.hasMore).toBe(false);
    expect(result.current.total).toBe(0);
  });

  it('exports search, loadMore, and other functions', () => {
    const { result } = renderHook(() => usePropertySearch());

    expect(typeof result.current.search).toBe('function');
    expect(typeof result.current.loadMore).toBe('function');
    expect(typeof result.current.retry).toBe('function');
    expect(typeof result.current.searchByBounds).toBe('function');
    expect(typeof result.current.getSuggestions).toBe('function');
    expect(typeof result.current.getTrending).toBe('function');
  });

  describe('error vs empty', () => {
    it('reports an empty result as success, not an error', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ data: [], total: 0, page: 1, limit: 20, hasMore: false }),
      );
      const { result } = renderHook(() => usePropertySearch());

      await act(async () => {
        await result.current.search('nothing here');
      });

      expect(result.current.results).toEqual([]);
      expect(result.current.error).toBeNull();
      expect(result.current.loading).toBe(false);
      expect(result.current.hasMore).toBe(false);
    });

    it('surfaces a failed request as an error instead', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ message: 'boom' }, false));
      const { result } = renderHook(() => usePropertySearch());

      await act(async () => {
        await result.current.search('castle');
      });

      expect(result.current.error).toBe('Search failed');
      expect(result.current.results).toEqual([]);
      expect(result.current.loading).toBe(false);
    });
  });

  describe('retry', () => {
    it('re-runs the last query and filters after a failure', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ message: 'boom' }, false));
      const { result } = renderHook(() => usePropertySearch());

      await act(async () => {
        await result.current.search('castle', { priceMax: 200 });
      });
      expect(result.current.error).toBe('Search failed');

      mockFetch.mockResolvedValueOnce(
        jsonResponse({ data: [beachHouse], total: 1, page: 1, limit: 20, hasMore: false }),
      );
      await act(async () => {
        await result.current.retry();
      });

      expect(result.current.error).toBeNull();
      expect(result.current.results).toEqual([beachHouse]);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      const retryUrl = String(mockFetch.mock.calls[1][0]);
      expect(retryUrl).toContain('q=castle');
      expect(retryUrl).toContain('max_price=200');
      expect(retryUrl).toContain('page=1');
    });
  });

  describe('loadMore', () => {
    it('does not queue duplicate requests while a page is in flight', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ data: [beachHouse], total: 40, page: 1, limit: 20, hasMore: true }),
      );
      const { result } = renderHook(() => usePropertySearch());

      await act(async () => {
        await result.current.search('beach');
      });
      expect(result.current.hasMore).toBe(true);

      // Page 2 never settles — simulates an impatient user hammering the button.
      mockFetch.mockImplementationOnce(() => new Promise(() => {}));

      act(() => {
        void result.current.loadMore();
      });
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(String(mockFetch.mock.calls[1][0])).toContain('page=2');
      expect(result.current.loading).toBe(true);

      act(() => {
        void result.current.loadMore();
      });
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result.current.loading).toBe(true);
    });

    it('keeps already-rendered results when page 2 fails', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ data: [beachHouse], total: 40, page: 1, limit: 20, hasMore: true }),
      );
      const { result } = renderHook(() => usePropertySearch());

      await act(async () => {
        await result.current.search('beach');
      });

      mockFetch.mockResolvedValueOnce(jsonResponse({ message: 'boom' }, false));
      await act(async () => {
        await result.current.loadMore();
      });

      expect(result.current.error).toBe('Search failed');
      // The user does not lose their place: page-1 results survive the failure.
      expect(result.current.results).toEqual([beachHouse]);
      expect(result.current.hasMore).toBe(true);
      expect(result.current.loading).toBe(false);
    });
  });

  describe('request de-duplication', () => {
    it('discards a superseded search’s stale response', async () => {
      const slow = deferred<unknown>();
      mockFetch.mockImplementationOnce(() => slow.promise);
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ data: [beachHouse], total: 1, page: 1, limit: 20, hasMore: false }),
      );

      const { result } = renderHook(() => usePropertySearch());

      act(() => {
        void result.current.search('old query');
      });
      await act(async () => {
        await result.current.search('new query');
      });
      expect(result.current.results).toEqual([beachHouse]);

      // The abandoned request resolves late — its data must not win.
      await act(async () => {
        slow.resolve(jsonResponse({ data: [staleCabin], total: 1, page: 1, limit: 20, hasMore: false }));
      });

      expect(result.current.results).toEqual([beachHouse]);
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBeNull();
    });
  });
});
