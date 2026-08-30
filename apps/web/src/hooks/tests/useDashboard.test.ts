import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDashboard } from '../useDashboard';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('useDashboard', () => {
  beforeEach(() => {
    mockFetch.mockClear();
    global.localStorage = {
      getItem: vi.fn(() => 'test-token'),
    } as any;
  });

  it('initializes with empty bookings and loading state', () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [],
          nextCursor: null,
        }),
    });

    const { result } = renderHook(() => useDashboard());

    expect(result.current.bookings).toEqual(expect.any(Array));
    expect(typeof result.current.isLoading).toBe('boolean');
    expect(typeof result.current.hasMore).toBe('boolean');
  });

  it('exports loadMore and refetch functions', () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [],
          nextCursor: null,
        }),
    });

    const { result } = renderHook(() => useDashboard());

    expect(typeof result.current.loadMore).toBe('function');
    expect(typeof result.current.refetch).toBe('function');
  });
});
