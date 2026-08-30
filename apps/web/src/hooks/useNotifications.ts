'use client';

import { createClient } from '@supabase/supabase-js';
import { useCallback, useEffect, useRef, useState } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
const API_BASE = `${API_URL}/api/v1/notifications`;

export interface AppNotification {
  id: string;
  user_id: string;
  type: string;
  data: Record<string, unknown>;
  read: boolean;
  created_at: string;
}

function getToken() {
  return typeof window !== 'undefined' ? localStorage.getItem('token') : null;
}

function authHeaders() {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * useNotifications — provides cursor-based infinite-scroll pagination.
 *
 * On mount, the first page is fetched automatically. Call `loadMore()` to
 * append the next page. Real-time inserts/updates/deletes from Supabase
 * Realtime are merged into the in-memory list.
 *
 * The legacy flat-array behaviour (no cursor) is preserved when the optional
 * `pageSize` prop is omitted — in that case `loadMore` is a no-op.
 */
export function useNotifications(userId?: string, pageSize = 20) {
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

  // Track the initial fetch so we don't double-fire
  const initialFetched = useRef(false);
  // Track in-flight load-more request to prevent duplicates on rapid calls
  const loadMoreInFlight = useRef(false);

  /** Fetch a page of notifications. When cursor is null, fetches the first page. */
  const fetchPage = useCallback(
    async (cursor: string | null, isFirst: boolean) => {
      const token = getToken();
      if (!token) {
        if (isFirst) setIsLoading(false);
        return;
      }

      if (isFirst) setIsLoading(true);
      else setIsLoadingMore(true);

      try {
        const params = new URLSearchParams({ limit: String(pageSize) });
        if (cursor) params.set('cursor', cursor);

        const res = await fetch(`${API_BASE}?${params.toString()}`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        // Check token again after request completes (it may have been removed during the request)
        const currentToken = getToken();
        if (!currentToken) {
          return;
        }

        if (res.ok) {
          const body = await res.json();

          // Cursor response: { data: [...], nextCursor: string|null }
          // Legacy response (flat array): backward-compat path
          if (Array.isArray(body)) {
            setNotifications(body as AppNotification[]);
            setNextCursor(null);
            setHasMore(false);
          } else {
            const pageData = body as { data: AppNotification[]; nextCursor: string | null };
            if (isFirst) {
              setNotifications(pageData.data);
            } else {
              // Append, deduplicating by id
              setNotifications((prev) => {
                const existingIds = new Set(prev.map((n) => n.id));
                const fresh = pageData.data.filter((n) => !existingIds.has(n.id));
                return [...prev, ...fresh];
              });
            }
            setNextCursor(pageData.nextCursor);
            setHasMore(pageData.nextCursor !== null);
          }
        }
      } catch {
        // Silently ignore network errors; existing state is preserved
      } finally {
        if (isFirst) setIsLoading(false);
        else setIsLoadingMore(false);
      }
    },
    [pageSize],
  );

  /** Load the first page on mount. */
  useEffect(() => {
    if (initialFetched.current) return;
    initialFetched.current = true;
    fetchPage(null, true);
  }, [fetchPage]);

  /** Load the next page (appends to list). */
  const loadMore = useCallback(() => {
    if (!hasMore || isLoadingMore || loadMoreInFlight.current) return;
    loadMoreInFlight.current = true;
    fetchPage(nextCursor, false).finally(() => {
      loadMoreInFlight.current = false;
    });
  }, [hasMore, isLoadingMore, nextCursor, fetchPage]);

  /** Refetch from the first page (e.g. after a pull-to-refresh). */
  const refetch = useCallback(() => {
    initialFetched.current = false;
    fetchPage(null, true);
  }, [fetchPage]);

  // Real-time subscription via Supabase Realtime (WebSocket)
  useEffect(() => {
    if (!userId) return;

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseKey) return;

    const client = createClient(supabaseUrl, supabaseKey);
    const channel = client
      .channel('notifications')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          // Prepend new notifications at the top
          setNotifications((prev) => {
            const incoming = payload.new as AppNotification;
            // Avoid duplicates from optimistic updates
            if (prev.some((n) => n.id === incoming.id)) return prev;
            return [incoming, ...prev];
          });
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          setNotifications((prev) =>
            prev.map((n) =>
              n.id === (payload.new as AppNotification).id ? (payload.new as AppNotification) : n,
            ),
          );
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'DELETE',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          setNotifications((prev) =>
            prev.filter((n) => n.id !== (payload.old as AppNotification).id),
          );
        },
      )
      .subscribe();

    return () => {
      client.removeChannel(channel);
    };
  }, [userId]);

  const markRead = useCallback(async (id: string) => {
    const token = getToken();
    if (!token) return;

    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
    await fetch(`${API_BASE}/${id}/read`, {
      method: 'PATCH',
      headers: authHeaders(),
    }).catch(() => {});
  }, []);

  const markAllRead = useCallback(async () => {
    const token = getToken();
    if (!token) return;

    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    await fetch(`${API_BASE}/read-all`, {
      method: 'PATCH',
      headers: authHeaders(),
    }).catch(() => {});
  }, []);

  const removeNotification = useCallback(async (id: string) => {
    const token = getToken();
    if (!token) return;

    setNotifications((prev) => prev.filter((n) => n.id !== id));
    await fetch(`${API_BASE}/${id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    }).catch(() => {});
  }, []);

  const unreadCount = notifications.filter((n) => !n.read).length;

  return {
    notifications,
    isLoading,
    isLoadingMore,
    hasMore,
    unreadCount,
    markRead,
    markAllRead,
    removeNotification,
    loadMore,
    refetch,
  };
}
