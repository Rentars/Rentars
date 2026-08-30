import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { usePropertySearch } from '../usePropertySearch';
import type { FilterState } from '@/components/search/FilterSidebar';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('usePropertySearch', () => {
  beforeEach(() => {
    mockFetch.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('cancels stale property search responses', async () => {
    const { result } = renderHook(() => usePropertySearch());

    let resolveOldRequest: ((value: any) => void) | null = null;
    let resolveNewRequest: ((value: any) => void) | null = null;

    mockFetch
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOldRequest = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveNewRequest = resolve;
          }),
      );

    act(() => {
      result.current.search('paris', { priceMin: 100 }, 1);
    });

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    act(() => {
      result.current.search('paris', { priceMin: 200 }, 1);
    });

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    const oldResults = [
      {
        id: '1',
        title: 'Old Apartment',
        price_per_night: 150,
      },
    ];

    const newResults = [
      {
        id: '2',
        title: 'New Apartment',
        price_per_night: 250,
      },
    ];

    if (resolveNewRequest) {
      await act(async () => {
        resolveNewRequest({
          ok: true,
          json: () =>
            Promise.resolve({
              data: newResults,
              total: 1,
              hasMore: false,
            }),
        });
      });
    }

    await waitFor(() => {
      expect(result.current.results).toHaveLength(1);
      expect(result.current.results[0].title).toBe('New Apartment');
    });

    if (resolveOldRequest) {
      await act(async () => {
        resolveOldRequest({
          ok: true,
          json: () =>
            Promise.resolve({
              data: oldResults,
              total: 1,
              hasMore: false,
            }),
        });
      });
    }

    await waitFor(() => {
      expect(result.current.results).toHaveLength(1);
      expect(result.current.results[0].title).toBe('New Apartment');
    });
  });

  it('resets pagination when search is called with page 1', async () => {
    const { result } = renderHook(() => usePropertySearch());

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [
            { id: '1', title: 'Property 1' },
            { id: '2', title: 'Property 2' },
          ],
          total: 2,
          hasMore: false,
        }),
    });

    act(() => {
      result.current.search('paris', { priceMin: 100 }, 1);
    });

    await waitFor(() => {
      expect(result.current.page).toBe(1);
    });

    expect(result.current.total).toBe(2);
    expect(result.current.results).toHaveLength(2);
  });

  it('loading state settles correctly after stale request is ignored', async () => {
    const { result } = renderHook(() => usePropertySearch());

    let resolveOldRequest: ((value: any) => void) | null = null;
    let resolveNewRequest: ((value: any) => void) | null = null;

    mockFetch
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOldRequest = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveNewRequest = resolve;
          }),
      );

    act(() => {
      result.current.search('paris', {}, 1);
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(true);
    });

    act(() => {
      result.current.search('london', {}, 1);
    });

    if (resolveNewRequest) {
      await act(async () => {
        resolveNewRequest({
          ok: true,
          json: () =>
            Promise.resolve({
              data: [{ id: '1', title: 'London Property' }],
              total: 1,
              hasMore: false,
            }),
        });
      });
    }

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    if (resolveOldRequest) {
      await act(async () => {
        resolveOldRequest({
          ok: true,
          json: () =>
            Promise.resolve({
              data: [{ id: '2', title: 'Paris Property' }],
              total: 1,
              hasMore: false,
            }),
        });
      });
    }

    expect(result.current.loading).toBe(false);
    expect(result.current.results).toHaveLength(1);
    expect(result.current.results[0].title).toBe('London Property');
  });

  it('does not show abort errors to user', async () => {
    const { result } = renderHook(() => usePropertySearch());

    mockFetch.mockImplementationOnce(() => {
      const controller = new AbortController();
      controller.abort();
      const error = new DOMException('Aborted', 'AbortError');
      return Promise.reject(error);
    });

    act(() => {
      result.current.search('paris', {}, 1);
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBeNull();
  });
});
