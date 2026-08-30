import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDashboard } from '../useDashboard';

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('useDashboard', () => {
  const mockBookings = [
    {
      id: 'b1',
      property_id: 'p1',
      guest_id: 'g1',
      check_in: '2024-09-01',
      check_out: '2024-09-05',
      total_price: 500,
      status: 'confirmed',
      created_at: '2024-08-01T00:00:00Z',
    },
    {
      id: 'b2',
      property_id: 'p2',
      guest_id: 'g2',
      check_in: '2024-09-10',
      check_out: '2024-09-15',
      total_price: 600,
      status: 'confirmed',
      created_at: '2024-08-02T00:00:00Z',
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    localStorage.setItem('token', 'test-token');
  });

  it('fetches bookings on mount', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: mockBookings, nextCursor: null }),
    });

    const { result } = renderHook(() => useDashboard());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/bookings'),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
      })
    );
    expect(result.current.bookings).toHaveLength(2);
  });

  it('resets cursor when sort changes (issue #455)', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: mockBookings, nextCursor: 'cursor-1' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [mockBookings[0]], nextCursor: null }),
      });

    const { result, rerender } = renderHook(
      ({ sort }) => useDashboard(20, null, sort, 'desc'),
      { initialProps: { sort: 'created' as const } }
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.bookings).toHaveLength(2);
    expect(result.current.hasMore).toBe(true);

    rerender({ sort: 'date' });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.bookings).toHaveLength(1);
    expect(result.current.hasMore).toBe(false);
  });

  it('handles error response with error message (issue #456)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: 'Session expired' }),
    });

    const { result } = renderHook(() => useDashboard());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe('Session expired');
  });

  it('falls back to generic error for malformed error response (issue #456)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('Invalid JSON');
      },
    });

    const { result } = renderHook(() => useDashboard());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe('HTTP 500');
  });

  it('resets bookings when status filter changes', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: mockBookings, nextCursor: null }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [mockBookings[0]], nextCursor: null }),
      });

    const { result, rerender } = renderHook(
      ({ status }) => useDashboard(20, status, 'created', 'desc'),
      { initialProps: { status: null as const } }
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.bookings).toHaveLength(2);

    rerender({ status: 'confirmed' as const });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.bookings).toHaveLength(1);
  });

  it('resets bookings when order changes', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: mockBookings, nextCursor: null }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [mockBookings[1], mockBookings[0]], nextCursor: null }),
      });

    const { result, rerender } = renderHook(
      ({ order }) => useDashboard(20, null, 'created', order),
      { initialProps: { order: 'desc' as const } }
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const firstOrder = result.current.bookings.map((b) => b.id);

    rerender({ order: 'asc' as const });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const secondOrder = result.current.bookings.map((b) => b.id);
    expect(firstOrder).not.toEqual(secondOrder);
  });

  it('sets loading false when no token', async () => {
    localStorage.removeItem('token');
    const { result } = renderHook(() => useDashboard());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.bookings).toHaveLength(0);
    expect(result.current.error).toBe('Not authenticated');
  });

  it('loads more bookings', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: mockBookings, nextCursor: 'cursor-1' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            {
              id: 'b3',
              property_id: 'p3',
              guest_id: 'g3',
              check_in: '2024-10-01',
              check_out: '2024-10-05',
              total_price: 700,
              status: 'confirmed',
              created_at: '2024-08-03T00:00:00Z',
            },
          ],
          nextCursor: null,
        }),
      });

    const { result } = renderHook(() => useDashboard());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.bookings).toHaveLength(2);
    expect(result.current.hasMore).toBe(true);

    await act(async () => {
      result.current.loadMore();
    });

    await waitFor(() => expect(result.current.isLoadingMore).toBe(false));
    expect(result.current.bookings).toHaveLength(3);
    expect(result.current.hasMore).toBe(false);
  });
});
