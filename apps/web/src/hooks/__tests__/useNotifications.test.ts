import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useNotifications } from '../useNotifications';

const mockFetch = vi.fn();
global.fetch = mockFetch;

const mockChannel = {
  on: vi.fn().mockReturnThis(),
  subscribe: vi.fn().mockReturnThis(),
};
const mockClient = {
  channel: vi.fn(() => mockChannel),
  removeChannel: vi.fn(),
};

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => mockClient),
}));

describe('useNotifications', () => {
  const mockNotifications = [
    {
      id: 'n1',
      user_id: 'u1',
      type: 'booking_created',
      data: {},
      read: false,
      created_at: '2024-01-01T00:00:00Z',
    },
    {
      id: 'n2',
      user_id: 'u1',
      type: 'payment_received',
      data: {},
      read: true,
      created_at: '2024-01-02T00:00:00Z',
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    localStorage.setItem('token', 'test-token');
  });

  it('fetches notifications on mount', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockNotifications,
    });

    const { result } = renderHook(() => useNotifications());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/notifications'),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
      })
    );
    expect(result.current.notifications).toHaveLength(2);
  });

  it('calculates unread count correctly', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockNotifications,
    });

    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.unreadCount).toBe(1);
  });

  it('marks a notification as read', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => mockNotifications })
      .mockResolvedValueOnce({ ok: true });

    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.markRead('n1');
    });

    expect(result.current.notifications.find((n) => n.id === 'n1')?.read).toBe(true);
  });

  it('marks all notifications as read', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => mockNotifications })
      .mockResolvedValueOnce({ ok: true });

    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.markAllRead();
    });

    expect(result.current.notifications.every((n) => n.read)).toBe(true);
    expect(result.current.unreadCount).toBe(0);
  });

  it('removes a notification', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => mockNotifications })
      .mockResolvedValueOnce({ ok: true });

    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.removeNotification('n1');
    });

    expect(result.current.notifications).toHaveLength(1);
    expect(result.current.notifications.find((n) => n.id === 'n1')).toBeUndefined();
  });

  it('sets loading false when no token', async () => {
    localStorage.removeItem('token');
    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.notifications).toHaveLength(0);
  });

  it('subscribes to real-time updates when userId is provided', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });

    const { result } = renderHook(() => useNotifications('u1'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(mockClient.channel).toHaveBeenCalledWith('notifications');
    expect(mockChannel.subscribe).toHaveBeenCalled();
  });

  it('ignores pending results after logout (issue #457)', async () => {
    mockFetch.mockImplementation(
      async () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              ok: true,
              json: async () => ({ data: mockNotifications, nextCursor: null }),
            });
          }, 50);
        })
    );

    const { result } = renderHook(() => useNotifications());
    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      localStorage.removeItem('token');
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    expect(result.current.notifications).toHaveLength(0);
  });

  it('prevents duplicate pagination on rapid loadMore calls (issue #458)', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: mockNotifications,
          nextCursor: 'cursor-1',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            {
              id: 'n3',
              user_id: 'u1',
              type: 'message',
              data: {},
              read: false,
              created_at: '2024-01-03T00:00:00Z',
            },
          ],
          nextCursor: null,
        }),
      });

    const { result } = renderHook(() => useNotifications(undefined, 20));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      result.current.loadMore();
      result.current.loadMore();
    });

    await waitFor(() => expect(result.current.isLoadingMore).toBe(false));

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.current.notifications).toHaveLength(3);
  });
});
