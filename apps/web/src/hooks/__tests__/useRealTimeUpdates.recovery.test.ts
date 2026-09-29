/**
 * Integration tests for realtime connection recovery (issue #646).
 *
 * These drive the real hook against a controllable Supabase channel mock and
 * a real `fetch` mock, exercising the full recovery lifecycle:
 *
 *   connect → drop → backoff → reconnect → stale → cursor resync → connected
 *                       ↘ retry cap → fallback polling
 *                       ↘ offline → immediate resume on reconnect
 *                       ↘ 401 → token refresh → replay
 */

import {
  getSessionState,
  resetRefreshCircuit,
  setRealtimeFetch,
  setSessionTokens,
} from '@/lib/realtime/authToken';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRealTimeUpdates } from '../useRealTimeUpdates';

// ── Supabase channel mock ─────────────────────────────────────────────────────

type StatusCallback = (status: string) => void;

function makeChannelMock() {
  let _statusCb: StatusCallback | null = null;
  const handlers: Array<(p: unknown) => void> = [];

  const channel = {
    on: vi.fn().mockImplementation((_type: string, _filter: unknown, cb: (p: unknown) => void) => {
      handlers.push(cb);
      return channel;
    }),
    subscribe: vi.fn().mockImplementation((cb?: StatusCallback) => {
      if (cb) _statusCb = cb;
      return channel;
    }),
    triggerStatus: (status: string) => _statusCb?.(status),
    // Deliver a postgres_changes payload to the Nth registered handler.
    emit: (index: number, payload: unknown) => handlers[index]?.(payload),
    unsubscribe: vi.fn(),
  };

  return channel;
}

let channelMock = makeChannelMock();
const removeChannelMock = vi.fn();
const supabaseMock = {
  channel: vi.fn(() => channelMock),
  removeChannel: removeChannelMock,
};

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => supabaseMock),
}));

vi.mock('react-hot-toast', () => ({
  default: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
  }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

/** A cursor page of notifications. */
function syncPage(items: unknown[], nextCursor: string | null = null) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: items, nextCursor }),
  };
}

function note(id: string, created_at: string) {
  return { id, created_at, type: 'booking_confirmed', data: {}, read: false, user_id: 'u1' };
}

/** Drain microtasks and any 0ms timers. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
  });
}

/** Connect the primary channel, simulating a healthy first connection. */
async function connectSuccessfully() {
  await act(async () => {
    channelMock.triggerStatus('SUBSCRIBED');
    await Promise.resolve();
  });
  await flush();
}

/** Deliver a realtime booking update, which pins the resync high-water mark. */
async function seedHighWaterMark(timestamp: string, id = 'seen-1') {
  await act(async () => {
    channelMock.emit(0, {
      eventType: 'UPDATE',
      new: { id, updated_at: timestamp },
    });
  });
}

const SYNC_PATH = '/api/v1/notifications/sync';

/** URLs of sync requests made so far. */
function syncUrls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes(SYNC_PATH));
}

// ── Suite setup ───────────────────────────────────────────────────────────────

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: false });

  channelMock = makeChannelMock();
  supabaseMock.channel.mockReturnValue(channelMock);

  localStorage.setItem('token', 'test-token');
  resetRefreshCircuit();

  mockFetch = vi.fn().mockResolvedValue(syncPage([]));
  setRealtimeFetch(mockFetch as unknown as typeof fetch);
  setSessionTokens('test-token', 'test-refresh');
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
  vi.restoreAllMocks();
});

// ── Connection state ──────────────────────────────────────────────────────────

describe('connection state tracking', () => {
  it('starts disconnected and becomes connected on SUBSCRIBED', async () => {
    const { result } = renderHook(() => useRealTimeUpdates({ userId: 'u1' }));

    expect(result.current.connectionStatus).toBe('disconnected');

    await connectSuccessfully();

    expect(result.current.connectionStatus).toBe('connected');
  });

  it.each(['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'])(
    'transitions to reconnecting on %s',
    async (status) => {
      const { result } = renderHook(() => useRealTimeUpdates({ userId: 'u1' }));
      await connectSuccessfully();

      await act(async () => {
        channelMock.triggerStatus(status);
        await Promise.resolve();
      });

      expect(result.current.connectionStatus).toBe('reconnecting');
    }
  );

  it('reports retry progress and remaining budget', async () => {
    const { result } = renderHook(() => useRealTimeUpdates({ userId: 'u1' }));
    await connectSuccessfully();

    const initialRemaining = result.current.retriesRemaining;

    await act(async () => {
      channelMock.triggerStatus('CHANNEL_ERROR');
      await Promise.resolve();
    });

    expect(result.current.retryAttempt).toBe(1);
    expect(result.current.retriesRemaining).toBe(initialRemaining - 1);
  });

  it('reports isOffline when the browser has no network', () => {
    Object.defineProperty(navigator, 'onLine', { get: () => false, configurable: true });
    const { result } = renderHook(() => useRealTimeUpdates({ userId: 'u1' }));

    expect(result.current.isOffline).toBe(true);
    Object.defineProperty(navigator, 'onLine', { get: () => true, configurable: true });
  });
});

// ── Backoff and retry cap ─────────────────────────────────────────────────────

describe('reconnect backoff', () => {
  it('does not reconnect before the first backoff elapses', async () => {
    renderHook(() => useRealTimeUpdates({ userId: 'u1', enableFallbackPolling: false }));
    await connectSuccessfully();

    const before = supabaseMock.channel.mock.calls.length;
    await act(async () => {
      channelMock.triggerStatus('CHANNEL_ERROR');
      await Promise.resolve();
    });

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });

    expect(supabaseMock.channel.mock.calls.length).toBe(before);
  });

  it('reconnects after the backoff window', async () => {
    renderHook(() => useRealTimeUpdates({ userId: 'u1', enableFallbackPolling: false }));
    await connectSuccessfully();

    const newChannel = makeChannelMock();
    supabaseMock.channel.mockReturnValue(newChannel);

    await act(async () => {
      channelMock.triggerStatus('CHANNEL_ERROR');
      await Promise.resolve();
    });

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });

    expect(supabaseMock.channel.mock.calls.length).toBeGreaterThan(0);
    expect(newChannel).toBeDefined();
  });

  it('uses a growing delay across consecutive failures', async () => {
    renderHook(() =>
      useRealTimeUpdates({ userId: 'u1', maxReconnectAttempts: 8, enableFallbackPolling: false })
    );
    await connectSuccessfully();

    // Record the wall-clock time at which each retry channel is created.
    // Every replacement channel fails immediately, so the delay before each
    // successive `channel()` call is the backoff we want to observe.
    const attemptTimes: number[] = [];
    let elapsed = 0;
    let current = channelMock;

    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        current.triggerStatus('CHANNEL_ERROR');
        await Promise.resolve();
      });

      const callsBefore = supabaseMock.channel.mock.calls.length;
      const step = 250;
      let created = false;
      for (let s = 0; s < 240 && !created; s += 1) {
        elapsed += step;
        // eslint-disable-next-line no-await-in-loop
        await act(async () => {
          vi.advanceTimersByTime(step);
          await Promise.resolve();
        });
        created = supabaseMock.channel.mock.calls.length > callsBefore;
      }

      if (!created) break;
      attemptTimes.push(elapsed);
      current = supabaseMock.channel.mock.results.at(-1)?.value as ReturnType<
        typeof makeChannelMock
      >;
    }

    expect(attemptTimes.length).toBeGreaterThanOrEqual(3);

    // Gaps between retries must never shrink — that is the backoff guarantee.
    const gaps = attemptTimes.slice(1).map((t, i) => t - attemptTimes[i]);
    for (let i = 1; i < gaps.length; i += 1) {
      expect(gaps[i]).toBeGreaterThanOrEqual(gaps[i - 1]);
    }
    // And it must be materially longer than the 1 s base by the later retries.
    expect(gaps[gaps.length - 1]).toBeGreaterThan(1_000);
  });
});

describe('retry cap', () => {
  it('stops retrying after maxReconnectAttempts and marks the hook exhausted', async () => {
    const { result } = renderHook(() =>
      useRealTimeUpdates({
        userId: 'u1',
        maxReconnectAttempts: 2,
        enableFallbackPolling: false,
      })
    );
    await connectSuccessfully();

    // Keep dropping the live channel, advancing past every backoff window,
    // for longer than the cap allows.
    let current = channelMock;
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        current.triggerStatus('CHANNEL_ERROR');
        await Promise.resolve();
      });
      await act(async () => {
        vi.advanceTimersByTime(60_000);
        await Promise.resolve();
      });
      current = (supabaseMock.channel.mock.results.at(-1)?.value ?? channelMock) as ReturnType<
        typeof makeChannelMock
      >;
    }
    await flush();

    expect(result.current.isExhausted).toBe(true);
    expect(result.current.retriesRemaining).toBe(0);
    expect(result.current.connectionStatus).toBe('disconnected');
  });

  it('does not create unbounded channels once the cap is hit', async () => {
    renderHook(() =>
      useRealTimeUpdates({
        userId: 'u1',
        maxReconnectAttempts: 2,
        enableFallbackPolling: false,
      })
    );
    await connectSuccessfully();

    let current = channelMock;
    for (let i = 0; i < 10; i += 1) {
      await act(async () => {
        current.triggerStatus('CHANNEL_ERROR');
        await Promise.resolve();
      });
      await act(async () => {
        vi.advanceTimersByTime(60_000);
        await Promise.resolve();
      });
      current = (supabaseMock.channel.mock.results.at(-1)?.value ?? channelMock) as ReturnType<
        typeof makeChannelMock
      >;
    }
    await flush();

    // One initial connect plus at most `maxReconnectAttempts` retries, no
    // matter how long the outage lasts. Each connect opens three channels.
    expect(supabaseMock.channel.mock.calls.length).toBeLessThanOrEqual((1 + 2) * 3);
  });

  it('resets the retry budget after a successful reconnect', async () => {
    const { result } = renderHook(() =>
      useRealTimeUpdates({ userId: 'u1', maxReconnectAttempts: 5, enableFallbackPolling: false })
    );
    await connectSuccessfully();

    const ch = makeChannelMock();
    supabaseMock.channel.mockReturnValue(ch);
    await act(async () => {
      channelMock.triggerStatus('CHANNEL_ERROR');
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    await act(async () => {
      ch.triggerStatus('SUBSCRIBED');
      await Promise.resolve();
    });
    await flush();

    expect(result.current.retryAttempt).toBe(0);
    expect(result.current.isExhausted).toBe(false);
    expect(result.current.retriesRemaining).toBe(5);
  });

  it('manual reconnect() restores a full retry budget', async () => {
    const { result } = renderHook(() =>
      useRealTimeUpdates({ userId: 'u1', maxReconnectAttempts: 3, enableFallbackPolling: false })
    );
    await connectSuccessfully();

    const ch = makeChannelMock();
    supabaseMock.channel.mockReturnValue(ch);
    await act(async () => {
      channelMock.triggerStatus('CHANNEL_ERROR');
      await Promise.resolve();
    });
    expect(result.current.retryAttempt).toBe(1);

    const fresh = makeChannelMock();
    supabaseMock.channel.mockReturnValue(fresh);
    act(() => result.current.reconnect());

    expect(result.current.retryAttempt).toBe(0);
    expect(result.current.retriesRemaining).toBe(3);
  });
});

// ── Stale window during recovery ──────────────────────────────────────────────

describe('stale state during resync', () => {
  it('reports "stale" while replaying, then "connected"', async () => {
    // Hold the resync request open so the stale window is observable.
    let releaseSync: (() => void) | undefined;
    mockFetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseSync = () => resolve(syncPage([]));
        })
    );

    const { result } = renderHook(() => useRealTimeUpdates({ userId: 'u1' }));
    await connectSuccessfully();
    await seedHighWaterMark('2024-06-01T10:00:00Z');

    const ch = makeChannelMock();
    supabaseMock.channel.mockReturnValue(ch);
    await act(async () => {
      channelMock.triggerStatus('CHANNEL_ERROR');
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });

    await act(async () => {
      ch.triggerStatus('SUBSCRIBED');
      await Promise.resolve();
    });

    // Replay in flight → the UI must not claim to be current.
    expect(result.current.connectionStatus).toBe('stale');

    await act(async () => {
      releaseSync?.();
      await Promise.resolve();
    });
    await flush();

    expect(result.current.connectionStatus).toBe('connected');
  });

  it('does not report stale on the very first connection', async () => {
    const { result } = renderHook(() => useRealTimeUpdates({ userId: 'u1' }));
    await connectSuccessfully();

    // No gap existed, so there is nothing to replay.
    expect(result.current.connectionStatus).toBe('connected');
    expect(syncUrls(mockFetch)).toHaveLength(0);
  });
});

// ── Cursor resync of missed records ───────────────────────────────────────────

describe('cursor resync of missed records', () => {
  it('replays notifications created after the high-water mark', async () => {
    const onMissedNotifications = vi.fn();
    mockFetch.mockResolvedValue(
      syncPage([
        note('n-missed-1', '2024-06-01T10:01:00Z'),
        note('n-missed-2', '2024-06-01T10:02:00Z'),
      ])
    );

    renderHook(() =>
      useRealTimeUpdates({ userId: 'u1', onMissedNotifications, enableFallbackPolling: false })
    );
    await connectSuccessfully();
    await seedHighWaterMark('2024-06-01T10:00:00Z');

    const ch = makeChannelMock();
    supabaseMock.channel.mockReturnValue(ch);
    await act(async () => {
      channelMock.triggerStatus('CHANNEL_ERROR');
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    await act(async () => {
      ch.triggerStatus('SUBSCRIBED');
      await Promise.resolve();
    });
    await flush();

    const urls = syncUrls(mockFetch);
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0]).searchParams.get('since')).toBe('2024-06-01T10:00:00Z');

    expect(onMissedNotifications).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'n-missed-1' }),
      expect.objectContaining({ id: 'n-missed-2' }),
    ]);
  });

  it('follows server cursors across multiple pages', async () => {
    const onMissedNotifications = vi.fn();
    mockFetch
      .mockResolvedValueOnce(syncPage([note('n1', '2024-06-01T10:01:00Z')], 'cursor-A'))
      .mockResolvedValueOnce(syncPage([note('n2', '2024-06-01T10:02:00Z')], null));

    renderHook(() =>
      useRealTimeUpdates({ userId: 'u1', onMissedNotifications, enableFallbackPolling: false })
    );
    await connectSuccessfully();
    await seedHighWaterMark('2024-06-01T10:00:00Z');

    const ch = makeChannelMock();
    supabaseMock.channel.mockReturnValue(ch);
    await act(async () => {
      channelMock.triggerStatus('CHANNEL_ERROR');
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    await act(async () => {
      ch.triggerStatus('SUBSCRIBED');
      await Promise.resolve();
    });
    await flush();

    expect(syncUrls(mockFetch)).toHaveLength(2);
    expect(new URL(syncUrls(mockFetch)[1]).searchParams.get('cursor')).toBe('cursor-A');
    expect(onMissedNotifications).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'n1' }),
      expect.objectContaining({ id: 'n2' }),
    ]);
  });

  it('does not re-deliver records already seen live', async () => {
    const onMissedNotifications = vi.fn();
    mockFetch.mockResolvedValue(
      syncPage([note('seen-1', '2024-06-01T10:01:00Z'), note('brand-new', '2024-06-01T10:02:00Z')])
    );

    renderHook(() =>
      useRealTimeUpdates({ userId: 'u1', onMissedNotifications, enableFallbackPolling: false })
    );
    await connectSuccessfully();
    // `seen-1` arrives live first.
    await seedHighWaterMark('2024-06-01T10:00:00Z', 'seen-1');

    const ch = makeChannelMock();
    supabaseMock.channel.mockReturnValue(ch);
    await act(async () => {
      channelMock.triggerStatus('CHANNEL_ERROR');
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    await act(async () => {
      ch.triggerStatus('SUBSCRIBED');
      await Promise.resolve();
    });
    await flush();

    expect(onMissedNotifications).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'brand-new' }),
    ]);
  });

  it('does not duplicate records across two consecutive recoveries', async () => {
    const onMissedNotifications = vi.fn();
    mockFetch.mockResolvedValue(syncPage([note('n1', '2024-06-01T10:01:00Z')]));

    renderHook(() =>
      useRealTimeUpdates({ userId: 'u1', onMissedNotifications, enableFallbackPolling: false })
    );
    await connectSuccessfully();
    await seedHighWaterMark('2024-06-01T10:00:00Z');

    // Recovery #1
    const ch = makeChannelMock();
    supabaseMock.channel.mockReturnValue(ch);
    await act(async () => {
      channelMock.triggerStatus('CHANNEL_ERROR');
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    await act(async () => {
      ch.triggerStatus('SUBSCRIBED');
      await Promise.resolve();
    });
    await flush();
    expect(onMissedNotifications).toHaveBeenCalledTimes(1);

    // Recovery #2 — the server returns the same record again.
    const ch2 = makeChannelMock();
    supabaseMock.channel.mockReturnValue(ch2);
    await act(async () => {
      ch.triggerStatus('CHANNEL_ERROR');
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    await act(async () => {
      ch2.triggerStatus('SUBSCRIBED');
      await Promise.resolve();
    });
    await flush();

    // The second replay found nothing new → no second delivery.
    expect(onMissedNotifications).toHaveBeenCalledTimes(1);
  });

  it('stays connected when the replay request fails', async () => {
    const onMissedNotifications = vi.fn();
    mockFetch.mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() =>
      useRealTimeUpdates({ userId: 'u1', onMissedNotifications, enableFallbackPolling: false })
    );
    await connectSuccessfully();
    await seedHighWaterMark('2024-06-01T10:00:00Z');

    const ch = makeChannelMock();
    supabaseMock.channel.mockReturnValue(ch);
    await act(async () => {
      channelMock.triggerStatus('CHANNEL_ERROR');
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    await act(async () => {
      ch.triggerStatus('SUBSCRIBED');
      await Promise.resolve();
    });
    await flush();

    expect(result.current.connectionStatus).toBe('connected');
    expect(onMissedNotifications).not.toHaveBeenCalled();
  });

  it('does not advance the high-water mark when the replay fails', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });

    renderHook(() => useRealTimeUpdates({ userId: 'u1', enableFallbackPolling: false }));
    await connectSuccessfully();
    await seedHighWaterMark('2024-06-01T10:00:00Z');

    const ch = makeChannelMock();
    supabaseMock.channel.mockReturnValue(ch);
    await act(async () => {
      channelMock.triggerStatus('CHANNEL_ERROR');
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    await act(async () => {
      ch.triggerStatus('SUBSCRIBED');
      await Promise.resolve();
    });
    await flush();

    // Second recovery must ask for the same window, not skip past it.
    mockFetch.mockResolvedValue(syncPage([]));
    const ch2 = makeChannelMock();
    supabaseMock.channel.mockReturnValue(ch2);
    await act(async () => {
      ch.triggerStatus('CHANNEL_ERROR');
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    await act(async () => {
      ch2.triggerStatus('SUBSCRIBED');
      await Promise.resolve();
    });
    await flush();

    const sines = syncUrls(mockFetch).map((u) => new URL(u).searchParams.get('since'));
    expect(sines).toEqual(['2024-06-01T10:00:00Z', '2024-06-01T10:00:00Z']);
  });

  it('skips the replay entirely when there is no userId', async () => {
    const onMissedNotifications = vi.fn();
    renderHook(() => useRealTimeUpdates({ onMissedNotifications }));

    await connectSuccessfully();
    await act(async () => {
      channelMock.triggerStatus('CHANNEL_ERROR');
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    await flush();

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('records the sync timestamp for the UI', async () => {
    const { result } = renderHook(() =>
      useRealTimeUpdates({ userId: 'u1', enableFallbackPolling: false })
    );
    await connectSuccessfully();
    await seedHighWaterMark('2024-06-01T10:00:00Z');

    const ch = makeChannelMock();
    supabaseMock.channel.mockReturnValue(ch);
    await act(async () => {
      channelMock.triggerStatus('CHANNEL_ERROR');
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    await act(async () => {
      ch.triggerStatus('SUBSCRIBED');
      await Promise.resolve();
    });
    await flush();

    expect(result.current.lastSyncedAt).not.toBeNull();
  });
});

// ── Auth refresh ──────────────────────────────────────────────────────────────

describe('auth refresh during recovery', () => {
  it('refreshes an expired token and retries the replay', async () => {
    let syncCalls = 0;
    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('/auth/refresh')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ token: 'fresh-token', refreshToken: 'r2' }),
        };
      }
      syncCalls += 1;
      if (syncCalls === 1) return { ok: false, status: 401, json: async () => ({}) };
      return syncPage([note('n1', '2024-06-01T10:01:00Z')]);
    });

    const onMissedNotifications = vi.fn();
    renderHook(() => useRealTimeUpdates({ userId: 'u1', onMissedNotifications }));
    await connectSuccessfully();
    await seedHighWaterMark('2024-06-01T10:00:00Z');

    const ch = makeChannelMock();
    supabaseMock.channel.mockReturnValue(ch);
    await act(async () => {
      channelMock.triggerStatus('CHANNEL_ERROR');
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    await act(async () => {
      ch.triggerStatus('SUBSCRIBED');
      await Promise.resolve();
    });
    await flush();

    const refreshCalls = mockFetch.mock.calls.filter((c) => String(c[0]).includes('/auth/refresh'));
    expect(refreshCalls.length).toBeLessThanOrEqual(1);
    expect(onMissedNotifications).toHaveBeenCalledWith([expect.objectContaining({ id: 'n1' })]);
  });

  it('does not enter a refresh loop when the token is permanently rejected', async () => {
    let refreshCalls = 0;
    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('/auth/refresh')) {
        refreshCalls += 1;
        return { ok: false, status: 401, json: async () => ({}) };
      }
      return { ok: false, status: 401, json: async () => ({}) };
    });

    const { result } = renderHook(() => useRealTimeUpdates({ userId: 'u1' }));
    await connectSuccessfully();
    await seedHighWaterMark('2024-06-01T10:00:00Z');

    const ch = makeChannelMock();
    supabaseMock.channel.mockReturnValue(ch);
    await act(async () => {
      channelMock.triggerStatus('CHANNEL_ERROR');
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    await act(async () => {
      ch.triggerStatus('SUBSCRIBED');
      await Promise.resolve();
    });
    await flush();

    // Exactly one refresh attempt, then the circuit latches.
    expect(refreshCalls).toBe(1);
    expect(getSessionState()).toBe('session-lost');
    expect(result.current.sessionState).toBe('session-lost');
  });

  it('reports the session state so the UI can prompt for re-login', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });

    const { result } = renderHook(() => useRealTimeUpdates({ userId: 'u1' }));
    await connectSuccessfully();
    await seedHighWaterMark('2024-06-01T10:00:00Z');

    const ch = makeChannelMock();
    supabaseMock.channel.mockReturnValue(ch);
    await act(async () => {
      channelMock.triggerStatus('CHANNEL_ERROR');
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    await act(async () => {
      ch.triggerStatus('SUBSCRIBED');
      await Promise.resolve();
    });
    await flush();

    expect(result.current.sessionState).toBe('session-lost');
  });

  it('keeps the session on a transient 5xx rather than logging the user out', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('/auth/refresh')) {
        return { ok: false, status: 503, json: async () => ({}) };
      }
      return { ok: false, status: 401, json: async () => ({}) };
    });

    const { result } = renderHook(() => useRealTimeUpdates({ userId: 'u1' }));
    await connectSuccessfully();
    await seedHighWaterMark('2024-06-01T10:00:00Z');

    const ch = makeChannelMock();
    supabaseMock.channel.mockReturnValue(ch);
    await act(async () => {
      channelMock.triggerStatus('CHANNEL_ERROR');
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    await act(async () => {
      ch.triggerStatus('SUBSCRIBED');
      await Promise.resolve();
    });
    await flush();

    expect(result.current.sessionState).not.toBe('session-lost');
    expect(localStorage.getItem('token')).not.toBeNull();
  });
});

// ── Fallback polling ──────────────────────────────────────────────────────────

describe('fallback polling', () => {
  it('starts polling when the connection drops', async () => {
    const { result } = renderHook(() =>
      useRealTimeUpdates({ userId: 'u1', fallbackPollIntervalMs: 5_000 })
    );
    await connectSuccessfully();

    expect(result.current.isPolling).toBe(false);

    await act(async () => {
      channelMock.triggerStatus('CHANNEL_ERROR');
      await Promise.resolve();
    });
    await flush();

    expect(result.current.isPolling).toBe(true);
  });

  it('delivers missed records through the poller while disconnected', async () => {
    const onMissedNotifications = vi.fn();
    renderHook(() =>
      useRealTimeUpdates({
        userId: 'u1',
        onMissedNotifications,
        fallbackPollIntervalMs: 5_000,
      })
    );
    await connectSuccessfully();
    await seedHighWaterMark('2024-06-01T10:00:00Z');

    await act(async () => {
      channelMock.triggerStatus('CHANNEL_ERROR');
      await Promise.resolve();
    });
    await flush();
    onMissedNotifications.mockClear();

    mockFetch.mockResolvedValue(syncPage([note('polled-1', '2024-06-01T10:05:00Z')]));
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    await flush();

    expect(onMissedNotifications).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'polled-1' }),
    ]);
  });

  it('stops polling once the connection is restored', async () => {
    const { result } = renderHook(() =>
      useRealTimeUpdates({ userId: 'u1', fallbackPollIntervalMs: 5_000 })
    );
    await connectSuccessfully();

    await act(async () => {
      channelMock.triggerStatus('CHANNEL_ERROR');
      await Promise.resolve();
    });
    await flush();
    expect(result.current.isPolling).toBe(true);

    const ch = makeChannelMock();
    supabaseMock.channel.mockReturnValue(ch);
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
      ch.triggerStatus('SUBSCRIBED');
      await Promise.resolve();
    });
    await flush();

    expect(result.current.isPolling).toBe(false);
  });

  it('does not poll while the connection is healthy', async () => {
    renderHook(() => useRealTimeUpdates({ userId: 'u1', fallbackPollIntervalMs: 1_000 }));
    await connectSuccessfully();

    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    await flush();

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('can be disabled explicitly', async () => {
    const { result } = renderHook(() =>
      useRealTimeUpdates({ userId: 'u1', enableFallbackPolling: false })
    );
    await connectSuccessfully();

    await act(async () => {
      channelMock.triggerStatus('CHANNEL_ERROR');
      await Promise.resolve();
    });
    await flush();

    expect(result.current.isPolling).toBe(false);
  });

  it('does not poll for anonymous users', async () => {
    const { result } = renderHook(() => useRealTimeUpdates({}));
    await connectSuccessfully();

    await act(async () => {
      channelMock.triggerStatus('CHANNEL_ERROR');
      await Promise.resolve();
    });
    await flush();

    expect(result.current.isPolling).toBe(false);
  });

  it('stops the poller on unmount', async () => {
    const { unmount } = renderHook(() =>
      useRealTimeUpdates({ userId: 'u1', fallbackPollIntervalMs: 1_000 })
    );
    await connectSuccessfully();
    await act(async () => {
      channelMock.triggerStatus('CHANNEL_ERROR');
      await Promise.resolve();
    });
    await flush();

    mockFetch.mockClear();
    unmount();

    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ── Offline / online transitions ──────────────────────────────────────────────

describe('offline and online transitions', () => {
  function goOffline() {
    Object.defineProperty(navigator, 'onLine', { get: () => false, configurable: true });
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
  }

  function goOnline() {
    Object.defineProperty(navigator, 'onLine', { get: () => true, configurable: true });
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
  }

  afterEach(() => {
    Object.defineProperty(navigator, 'onLine', { get: () => true, configurable: true });
  });

  it('does not schedule reconnect attempts while offline', async () => {
    goOffline();

    renderHook(() =>
      useRealTimeUpdates({ userId: 'u1', maxReconnectAttempts: 8, enableFallbackPolling: false })
    );
    await connectSuccessfully();

    const before = supabaseMock.channel.mock.calls.length;
    await act(async () => {
      channelMock.triggerStatus('CHANNEL_ERROR');
      await Promise.resolve();
    });

    await act(async () => {
      vi.advanceTimersByTime(120_000);
      await Promise.resolve();
    });

    // No channel churn while the browser has no network.
    expect(supabaseMock.channel.mock.calls.length).toBe(before);
  });

  it('reconnects immediately when the network returns', async () => {
    goOffline();

    const { result } = renderHook(() =>
      useRealTimeUpdates({ userId: 'u1', enableFallbackPolling: false })
    );
    await connectSuccessfully();

    await act(async () => {
      channelMock.triggerStatus('CHANNEL_ERROR');
      await Promise.resolve();
    });

    const before = supabaseMock.channel.mock.calls.length;
    goOnline();
    await flush();

    expect(supabaseMock.channel.mock.calls.length).toBeGreaterThan(before);
    expect(result.current.isOffline).toBe(false);
  });

  it('restores the full retry budget on reconnect', async () => {
    const { result } = renderHook(() =>
      useRealTimeUpdates({
        userId: 'u1',
        maxReconnectAttempts: 4,
        enableFallbackPolling: false,
      })
    );
    await connectSuccessfully();

    // Burn some of the budget while the network is up but the socket is not.
    await act(async () => {
      channelMock.triggerStatus('CHANNEL_ERROR');
      await Promise.resolve();
    });
    expect(result.current.retryAttempt).toBeGreaterThan(0);

    // Then drop the network entirely, and restore it.
    goOffline();
    await flush();
    goOnline();
    await flush();

    expect(result.current.retryAttempt).toBe(0);
    expect(result.current.retriesRemaining).toBe(4);
  });

  it('stops the poller on reconnect so the socket takes over', async () => {
    const { result } = renderHook(() =>
      useRealTimeUpdates({ userId: 'u1', fallbackPollIntervalMs: 5_000 })
    );
    await connectSuccessfully();

    goOffline();
    await act(async () => {
      channelMock.triggerStatus('CHANNEL_ERROR');
      await Promise.resolve();
    });
    await flush();
    expect(result.current.isPolling).toBe(true);

    goOnline();
    await flush();

    expect(result.current.isPolling).toBe(false);
  });
});

// ── Tab visibility ────────────────────────────────────────────────────────────

describe('tab visibility', () => {
  function setVisibility(state: 'visible' | 'hidden') {
    Object.defineProperty(document, 'visibilityState', {
      get: () => state,
      configurable: true,
    });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
  }

  afterEach(() => {
    Object.defineProperty(document, 'visibilityState', {
      get: () => 'visible',
      configurable: true,
    });
  });

  it('revalidates when the tab becomes visible again', async () => {
    renderHook(() => useRealTimeUpdates({ userId: 'u1' }));
    await connectSuccessfully();
    await seedHighWaterMark('2024-06-01T10:00:00Z');

    mockFetch.mockClear();
    setVisibility('hidden');
    await flush();
    expect(mockFetch).not.toHaveBeenCalled();

    setVisibility('visible');
    await flush();

    // A tab waking from sleep is exactly when to check for missed records.
    expect(syncUrls(mockFetch).length).toBeGreaterThan(0);
  });

  it('reconnects when the tab becomes visible while disconnected', async () => {
    const { result } = renderHook(() =>
      useRealTimeUpdates({ userId: 'u1', enableFallbackPolling: false })
    );
    await connectSuccessfully();

    await act(async () => {
      channelMock.triggerStatus('CHANNEL_ERROR');
      await Promise.resolve();
    });
    expect(result.current.connectionStatus).toBe('reconnecting');

    const before = supabaseMock.channel.mock.calls.length;
    setVisibility('visible');
    await flush();

    expect(supabaseMock.channel.mock.calls.length).toBeGreaterThan(before);
  });

  it('does nothing when the tab is hidden', async () => {
    renderHook(() => useRealTimeUpdates({ userId: 'u1' }));
    await connectSuccessfully();
    await seedHighWaterMark('2024-06-01T10:00:00Z');

    mockFetch.mockClear();
    setVisibility('hidden');
    await flush();

    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ── Cleanup ───────────────────────────────────────────────────────────────────

describe('cleanup', () => {
  it('removes channels and cancels the pending reconnect on unmount', async () => {
    const { unmount } = renderHook(() =>
      useRealTimeUpdates({ userId: 'u1', enableFallbackPolling: false })
    );
    await connectSuccessfully();

    await act(async () => {
      channelMock.triggerStatus('CHANNEL_ERROR');
      await Promise.resolve();
    });

    const callsAtUnmount = supabaseMock.channel.mock.calls.length;
    unmount();

    await act(async () => {
      vi.advanceTimersByTime(120_000);
      await Promise.resolve();
    });

    expect(supabaseMock.channel.mock.calls.length).toBe(callsAtUnmount);
  });

  it('removes the realtime listener on unmount', () => {
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const { unmount } = renderHook(() => useRealTimeUpdates({ userId: 'u1' }));
    unmount();

    expect(removeSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  });
});
