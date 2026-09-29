'use client';

import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { type SessionState, getSessionState, resetRefreshCircuit } from '@/lib/realtime/authToken';
import {
  NO_RETRY,
  calculateBackoffDelay,
  canRetry,
  remainingAttempts,
} from '@/lib/realtime/backoff';
import { DEFAULT_POLL_INTERVAL_MS, createFallbackPoller } from '@/lib/realtime/fallbackPoller';
import { type ResyncRecord, resyncRecords } from '@/lib/realtime/resync';
import { type RealtimeChannel, createClient } from '@supabase/supabase-js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
const NOTIFICATIONS_SYNC_URL = `${API_URL}/api/v1/notifications/sync`;

/**
 * Credentials are read at call time rather than module load. Next.js inlines
 * `process.env.NEXT_PUBLIC_*` at build time, so this is equivalent in
 * production, and it keeps the guard verifiable in tests.
 */
function realtimeConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

// ── Reconnection config ────────────────────────────────────────────────────────

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const BACKOFF_MULTIPLIER = 2;
const BACKOFF_JITTER_RATIO = 0.25;

/**
 * Hard cap on consecutive reconnect attempts. Past this the client stops
 * hammering the socket and relies on HTTP polling until connectivity returns
 * — this is what prevents unbounded server and battery drain.
 */
export const MAX_RECONNECT_ATTEMPTS = 8;

// ── Connection status ──────────────────────────────────────────────────────────

/**
 * `stale` means the socket is up but we have not yet finished replaying
 * whatever was missed while it was down. The UI must not claim to be current
 * during that window — that is exactly the stale-UI bug this issue is about.
 */
export type ConnectionStatus = 'connected' | 'reconnecting' | 'disconnected' | 'stale';

// ── Public API ─────────────────────────────────────────────────────────────────

export interface RealtimeOptions {
  userId?: string;
  onBookingStatusChange?: (booking: unknown) => void;
  onNewBookingNotification?: (booking: unknown) => void;
  onEscrowStatusChange?: (escrow: unknown) => void;
  /** Called with notifications missed while disconnected, deduplicated. */
  onMissedNotifications?: (notifications: unknown[]) => void;
  /** Overrides the reconnect attempt cap. Useful in tests. */
  maxReconnectAttempts?: number;
  /** Disable the HTTP polling fallback. Defaults to true. */
  enableFallbackPolling?: boolean;
  /** First fallback-poll delay in ms. Defaults to 15 s. */
  fallbackPollIntervalMs?: number;
}

export interface RealtimeResult {
  /** Current connection status of the real-time channel. */
  connectionStatus: ConnectionStatus;
  /** Consecutive reconnect attempts made since the last success. */
  retryAttempt: number;
  /** Retries left before the cap stops automatic reconnection. */
  retriesRemaining: number;
  /** True when the retry cap was hit and only polling is keeping data fresh. */
  isExhausted: boolean;
  /** True while the fallback poller is running. */
  isPolling: boolean;
  /** True when the browser reports no network connectivity. */
  isOffline: boolean;
  /** Auth session state, so the UI can prompt for re-login after a hard 401. */
  sessionState: SessionState;
  /** ISO timestamp of the last completed sync, or null if never. */
  lastSyncedAt: string | null;
  /** Manually trigger an immediate reconnect + resync. */
  reconnect: () => void;
}

interface RealtimeNotification extends ResyncRecord {
  id: string;
  created_at?: string;
}

const RESYNC_PAGE_LIMIT = 50;
const RESYNC_MAX_PAGES = 5;

// ── Hook ───────────────────────────────────────────────────────────────────────

export function useRealTimeUpdates(options: RealtimeOptions = {}): RealtimeResult {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [isExhausted, setIsExhausted] = useState(false);
  const [isPolling, setIsPolling] = useState(false);
  const [sessionState, setSessionState] = useState<SessionState>('active');
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);

  const { isOnline, justReconnected } = useOnlineStatus();

  // Stable ref to options so the subscription effect doesn't re-run on every
  // render just because the caller passes a new object literal.
  const optionsRef = useRef<RealtimeOptions>(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  // ── Refs (all mutable state that must survive re-render/reconnect) ─────────

  /** High-water mark for cursor resync; survives channel teardown. */
  const lastSeenAtRef = useRef<string | null>(null);
  /** Ids already delivered, so overlapping recoveries never double-deliver. */
  const seenIdsRef = useRef<Set<string>>(new Set());

  const retryAttemptRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);
  const connectRef = useRef<() => void>(() => {});
  const pollerRef = useRef<ReturnType<typeof createFallbackPoller> | null>(null);
  const supabaseRef = useRef<ReturnType<typeof createClient> | null>(null);
  // Typed as the Supabase channel type so `removeChannel` accepts them; the
  // original `unknown[]` was never assignable.
  const subscriptionsRef = useRef<RealtimeChannel[]>([]);

  /** True once at least one subscription has succeeded — gates first resync. */
  const hasConnectedRef = useRef(false);

  const onlineRef = useRef(isOnline);
  onlineRef.current = isOnline;
  const statusRef = useRef(connectionStatus);
  statusRef.current = connectionStatus;

  const backoffOptions = useMemo(
    () => ({
      baseDelayMs: BACKOFF_BASE_MS,
      maxDelayMs: BACKOFF_MAX_MS,
      multiplier: BACKOFF_MULTIPLIER,
      jitterRatio: BACKOFF_JITTER_RATIO,
      maxAttempts:
        typeof options.maxReconnectAttempts === 'number'
          ? Math.max(0, Math.floor(options.maxReconnectAttempts))
          : MAX_RECONNECT_ATTEMPTS,
    }),
    [options.maxReconnectAttempts]
  );
  const backoffRef = useRef(backoffOptions);
  backoffRef.current = backoffOptions;

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /** Advance the resync high-water mark from an observed record. */
  const markSeen = useCallback((id?: string, timestamp?: string) => {
    if (id) seenIdsRef.current.add(id);
    if (timestamp && (!lastSeenAtRef.current || timestamp > lastSeenAtRef.current)) {
      lastSeenAtRef.current = timestamp;
    }
  }, []);

  const deliverFresh = useCallback((items: RealtimeNotification[]) => {
    const fresh = items.filter((n) => !seenIdsRef.current.has(n.id));
    for (const n of fresh) {
      seenIdsRef.current.add(n.id);
    }
    if (fresh.length > 0) {
      optionsRef.current.onMissedNotifications?.(fresh);
    }
    return fresh.length;
  }, []);

  /**
   * Replay everything created since the high-water mark, following cursors.
   * Idempotent: results are deduplicated by id, so an interrupted recovery
   * that is retried re-delivers nothing.
   */
  const runResync = useCallback(
    async (reason: 'reconnect' | 'poll' | 'visibility') => {
      const { userId } = optionsRef.current;
      if (!userId) return;

      const result = await resyncRecords<RealtimeNotification>({
        endpoint: NOTIFICATIONS_SYNC_URL,
        // On the very first connection we have no high-water mark and nothing
        // was missed, so skip the request entirely rather than replaying the
        // user's entire inbox.
        since: lastSeenAtRef.current,
        limit: RESYNC_PAGE_LIMIT,
        maxPages: RESYNC_MAX_PAGES,
      });

      if (!isMountedRef.current) return;

      if (result.error) {
        // Deliberately do NOT advance the high-water mark on failure — the
        // next attempt must retry the same window, not skip those records.
        if (result.error === 'http_401' || result.error === 'http_403') {
          setSessionState(getSessionState());
        }
        console.warn(`[useRealTimeUpdates] Resync (${reason}) failed: ${result.error}`);
        return;
      }

      if (result.newestCursor) {
        lastSeenAtRef.current = result.newestCursor;
      }

      if (isMountedRef.current) {
        setSessionState(getSessionState());
        setLastSyncedAt(new Date().toISOString());
      }

      deliverFresh(result.items);
    },
    [deliverFresh]
  );

  const cleanup = useCallback(() => {
    if (!supabaseRef.current) return;
    subscriptionsRef.current.forEach((channel) => {
      try {
        supabaseRef.current?.removeChannel(channel);
      } catch {
        /* ignore */
      }
    });
    subscriptionsRef.current = [];
  }, []);

  // ── Fallback polling ────────────────────────────────────────────────────────

  /**
   * Keep critical updates flowing over HTTP when the socket is unavailable.
   * Runs in parallel with the reconnect backoff, so a slow recovery shows
   * fresh data rather than a frozen list.
   */
  const startFallbackPolling = useCallback(() => {
    const { userId, enableFallbackPolling = true, fallbackPollIntervalMs } = optionsRef.current;
    if (!userId || !enableFallbackPolling) return;
    if (pollerRef.current?.isRunning()) return;

    const poller = createFallbackPoller({
      tick: async () => {
        if (!onlineRef.current) return;
        // resyncRecords uses authenticatedFetch, so an expired access token
        // is refreshed once and the request replayed rather than 401-ing
        // forever.
        const result = await resyncRecords<RealtimeNotification>({
          endpoint: NOTIFICATIONS_SYNC_URL,
          since: lastSeenAtRef.current,
          limit: RESYNC_PAGE_LIMIT,
          maxPages: 2,
        });
        if (result.error) throw new Error(result.error);
        if (result.newestCursor) lastSeenAtRef.current = result.newestCursor;
        if (isMountedRef.current) {
          setLastSyncedAt(new Date().toISOString());
          setSessionState(getSessionState());
        }
        deliverFresh(result.items);
      },
      intervalMs: fallbackPollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      maxIntervalMs: 60_000,
      maxAttempts: backoffRef.current.maxAttempts,
      onError: (err, attempt) => {
        console.warn(
          `[useRealTimeUpdates] Fallback poll failed (attempt ${attempt}):`,
          err instanceof Error ? err.message : err
        );
      },
      onExhausted: () => {
        if (!isMountedRef.current) return;
        setIsPolling(false);
        setIsExhausted(true);
        setConnectionStatus('disconnected');
      },
    });

    pollerRef.current = poller;
    poller.start();
    setIsPolling(true);
  }, [deliverFresh]);

  // ── Disconnect handling ─────────────────────────────────────────────────────

  /**
   * Mark the connection non-current, schedule a jittered backoff retry, and
   * keep polling in the background. Once the attempt cap is hit, stop
   * retrying the socket entirely and let polling carry the load.
   */
  const handleDisconnect = useCallback(
    (reason: string) => {
      if (!isMountedRef.current) return;

      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }

      // Offline: don't burn the retry budget on a socket that cannot open.
      // The `online` event will resume us.
      if (!onlineRef.current) {
        setConnectionStatus('disconnected');
        startFallbackPolling();
        return;
      }

      const attempt = retryAttemptRef.current;
      const delay = calculateBackoffDelay(attempt, backoffRef.current);

      if (delay === NO_RETRY || !canRetry(attempt, backoffRef.current)) {
        // Cap reached. Stop retrying the socket; polling carries the load
        // until connectivity returns or the user reconnects manually.
        console.warn(
          `[useRealTimeUpdates] Reconnect cap reached (${reason}); falling back to polling`
        );
        // Clamp the counter so the UI shows the real budget spent rather than
        // an ever-climbing number for retries that are no longer attempted.
        retryAttemptRef.current = backoffRef.current.maxAttempts;
        setRetryAttempt(backoffRef.current.maxAttempts);
        setIsExhausted(true);
        setConnectionStatus('disconnected');
        startFallbackPolling();
        return;
      }

      retryAttemptRef.current = attempt + 1;
      setRetryAttempt(retryAttemptRef.current);
      setConnectionStatus('reconnecting');

      console.log(
        `[useRealTimeUpdates] Reconnecting in ${Math.round(delay)}ms (attempt ${attempt + 1})`
      );

      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null;
        if (isMountedRef.current) connectRef.current();
      }, delay);

      startFallbackPolling();
    },
    [startFallbackPolling]
  );

  // ── Channel lifecycle ───────────────────────────────────────────────────────

  /** Shared subscribe callback for every channel. */
  const handleChannelStatus = useCallback(
    (status: string) => {
      if (!isMountedRef.current) return;

      if (status === 'SUBSCRIBED') {
        const isRecovery = hasConnectedRef.current;
        hasConnectedRef.current = true;
        retryAttemptRef.current = 0;
        setRetryAttempt(0);
        setIsExhausted(false);

        if (!isRecovery) {
          // First connect of this session — nothing was missed, so we are
          // immediately current.
          setConnectionStatus('connected');
        } else {
          // Recovery: surface `stale` until the replay finishes so the UI
          // never shows a half-synced list as if it were live.
          setConnectionStatus('stale');
          void runResync('reconnect').finally(() => {
            if (isMountedRef.current) setConnectionStatus('connected');
          });
        }

        // Realtime is healthy again, so the poller is redundant.
        pollerRef.current?.stop();
        pollerRef.current = null;
        setIsPolling(false);
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        handleDisconnect(status);
      }
    },
    [runResync, handleDisconnect]
  );

  const connect = useCallback(() => {
    if (!realtimeConfigured()) {
      console.warn('[useRealTimeUpdates] Supabase credentials not configured');
      return;
    }

    // Nothing to do while the browser has no network — resuming now would
    // spend the retry budget we want intact for the real recovery.
    if (!onlineRef.current) return;

    cleanup();

    try {
      if (!supabaseRef.current) {
        supabaseRef.current = createClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL as string,
          process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string
        );
      }

      const { userId } = optionsRef.current;

      // ── Booking status changes ───────────────────────────────────────────────
      const bookingChannel = supabaseRef.current
        .channel('rt-bookings')
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'bookings',
            filter: userId ? `tenant_id=eq.${userId}` : undefined,
          },
          (payload) => {
            const row = payload.new as { id?: string; updated_at?: string; created_at?: string };
            markSeen(row.id, row.updated_at ?? row.created_at);
            if (payload.eventType === 'UPDATE') {
              optionsRef.current.onBookingStatusChange?.(payload.new);
              toast.success('Booking status updated');
            }
          }
        )
        .subscribe(handleChannelStatus);

      subscriptionsRef.current.push(bookingChannel);

      // ── Host new-booking notifications ───────────────────────────────────────
      if (userId) {
        const hostChannel = supabaseRef.current
          .channel('rt-host-notifications')
          .on(
            'postgres_changes',
            {
              event: 'INSERT',
              schema: 'public',
              table: 'bookings',
              filter: `owner_id=eq.${userId}`,
            },
            (payload) => {
              const row = payload.new as { id?: string; created_at?: string; updated_at?: string };
              markSeen(row.id, row.created_at ?? row.updated_at);
              optionsRef.current.onNewBookingNotification?.(payload.new);
              toast.success('New booking received!');
            }
          )
          .subscribe(handleChannelStatus);

        subscriptionsRef.current.push(hostChannel);
      }

      // ── Escrow status updates ────────────────────────────────────────────────
      const escrowChannel = supabaseRef.current
        .channel('rt-escrow-updates')
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'escrow_transactions',
          },
          (payload) => {
            const row = payload.new as {
              id?: string;
              updated_at?: string;
              created_at?: string;
              status?: string;
            };
            markSeen(row.id, row.updated_at ?? row.created_at);
            optionsRef.current.onEscrowStatusChange?.(payload.new);
            if (payload.eventType === 'UPDATE') {
              if (row.status === 'released') toast.success('Escrow released!');
              else if (row.status === 'locked') toast('Escrow locked');
            }
          }
        )
        .subscribe(handleChannelStatus);

      subscriptionsRef.current.push(escrowChannel);
    } catch (error) {
      console.error('[useRealTimeUpdates] Failed to set up subscriptions:', error);
      handleDisconnect('setup_error');
    }
  }, [cleanup, markSeen, handleChannelStatus, handleDisconnect]);

  connectRef.current = connect;

  const reconnect = useCallback(() => {
    if (!isMountedRef.current) return;
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    // An explicit user action resets both budgets so it gets a full set of
    // attempts rather than inheriting a nearly-exhausted counter.
    retryAttemptRef.current = 0;
    setRetryAttempt(0);
    setIsExhausted(false);
    resetRefreshCircuit();
    setSessionState(getSessionState());
    connectRef.current();
  }, []);

  // ── Mount / unmount ──────────────────────────────────────────────────────────

  useEffect(() => {
    isMountedRef.current = true;

    if (!realtimeConfigured()) {
      console.warn('[useRealTimeUpdates] Supabase credentials not configured');
      return;
    }

    connectRef.current();

    return () => {
      isMountedRef.current = false;
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      pollerRef.current?.stop();
      pollerRef.current = null;
      cleanup();
    };
  }, [cleanup]);

  // ── Network transitions ─────────────────────────────────────────────────────
  // Regaining connectivity is the strongest available signal that the socket
  // should come back immediately, so reset the attempt counter and reconnect
  // rather than serving out the remaining backoff.
  useEffect(() => {
    if (!isOnline) {
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      setConnectionStatus((prev) => (prev === 'connected' ? 'disconnected' : prev));
      return;
    }
    if (justReconnected) {
      retryAttemptRef.current = 0;
      setRetryAttempt(0);
      setIsExhausted(false);
      pollerRef.current?.stop();
      pollerRef.current = null;
      setIsPolling(false);
      connectRef.current();
    }
  }, [isOnline, justReconnected]);

  // ── Tab visibility ──────────────────────────────────────────────────────────
  // Browsers throttle sockets in background tabs and may drop them silently
  // after the machine sleeps. A tab becoming visible is exactly when to
  // revalidate instead of trusting a connection that may have died.
  useEffect(() => {
    if (typeof document === 'undefined') return;

    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      if (!isMountedRef.current) return;
      if (!onlineRef.current) return;

      void runResync('visibility');

      if (statusRef.current !== 'connected') {
        retryAttemptRef.current = 0;
        setRetryAttempt(0);
        connectRef.current();
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [runResync]);

  return {
    connectionStatus,
    retryAttempt,
    retriesRemaining: remainingAttempts(retryAttempt, backoffOptions),
    isExhausted,
    isPolling,
    isOffline: !isOnline,
    sessionState,
    lastSyncedAt,
    reconnect,
  };
}
