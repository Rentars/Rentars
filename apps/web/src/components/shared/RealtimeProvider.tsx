'use client';

import { type RealtimeResult, useRealTimeUpdates } from '@/hooks/useRealTimeUpdates';
import { useAuth } from '@/hooks/useUserRole';
import { type ReactNode, createContext, useContext } from 'react';

const RealtimeContext = createContext<RealtimeResult | null>(null);

/**
 * Owns the single realtime connection for the app.
 *
 * Previously each consumer opened its own Supabase client and WebSocket —
 * `NotificationBell` and `NotificationDropdown` alone created two. Mounting
 * this provider once at the root means one channel set, one reconnect
 * backoff budget, and one fallback poller for the whole page.
 */
export function RealtimeProvider({
  userId,
  onMissedNotifications,
  children,
}: {
  /** Overrides the user id from the auth context. Mostly for tests. */
  userId?: string;
  onMissedNotifications?: (notifications: unknown[]) => void;
  children: ReactNode;
}) {
  // The provider is mounted inside AuthProvider in the root layout, so the
  // authenticated user id is available without threading it through props.
  const { user } = useAuth();
  const value = useRealTimeUpdates({ userId: userId ?? user?.id, onMissedNotifications });

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

/**
 * Realtime connection state. Must be used inside a `RealtimeProvider`.
 */
export function useRealtimeConnection(): RealtimeResult {
  const ctx = useContext(RealtimeContext);
  if (!ctx) {
    throw new Error('useRealtimeConnection must be used within a RealtimeProvider');
  }
  return ctx;
}

/**
 * Realtime state that degrades to a safe default outside a provider, for
 * components that may render inside or outside the provider tree (Storybook,
 * isolated component tests, error boundaries).
 */
export function useOptionalRealtimeConnection(): RealtimeResult {
  const ctx = useContext(RealtimeContext);
  return (
    ctx ?? {
      connectionStatus: 'disconnected',
      retryAttempt: 0,
      retriesRemaining: 0,
      isExhausted: false,
      isPolling: false,
      isOffline: false,
      sessionState: 'active',
      lastSyncedAt: null,
      reconnect: () => {},
    }
  );
}
