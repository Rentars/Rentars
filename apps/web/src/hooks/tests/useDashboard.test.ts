import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useDashboard } from '../useDashboard';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);
global.localStorage = {
  getItem: vi.fn(() => 'test-token'),
} as any;

describe('useDashboard', () => {
  beforeEach(() => {
    mockFetch.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('prevents duplicate page loads on rapid loadMore clicks', async () => {
    let resolveFirstRequest: ((value: any) => void) | null = null;

    mockFetch
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstRequest = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                data: [{ id: '3', status: 'completed' }],
                nextCursor: 'cursor-3',
              }),
          }),
      );

    const { result } = renderHook(() => useDashboard());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    act(() => {
      result.current.loadMore();
    });

    act(() => {
      result.current.loadMore();
    });

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    if (resolveFirstRequest) {
      await act(async () => {
        resolveFirstRequest({
          ok: true,
          json: () =>
            Promise.resolve({
              data: [{ id: '2', status: 'pending' }],
              nextCursor: 'cursor-2',
            }),
        });
      });
    }

    await waitFor(() => {
      expect(result.current.isLoadingMore).toBe(false);
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('allows loadMore after first request settles', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [{ id: '1', status: 'pending' }],
          nextCursor: 'cursor-1',
        }),
    });

    const { result } = renderHook(() => useDashboard());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    act(() => {
      result.current.loadMore();
    });

    await waitFor(() => {
      expect(result.current.isLoadingMore).toBe(false);
    });

    act(() => {
      result.current.loadMore();
    });

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });

  it('does not issue request if no more pages available', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [{ id: '1', status: 'pending' }],
          nextCursor: null,
        }),
    });

    const { result } = renderHook(() => useDashboard());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.hasMore).toBe(false);

    act(() => {
      result.current.loadMore();
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
