/**
 * Unit tests for the auth token lifecycle (issue #646).
 *
 * The critical property under test: an expired or revoked token must NOT
 * produce an unbounded `401 → refresh → 401` loop. The circuit breaker is
 * what makes that safe.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MAX_REFRESH_ATTEMPTS,
  authenticatedFetch,
  clearSession,
  getAccessToken,
  getRefreshFailureCount,
  getRefreshToken,
  getSessionState,
  refreshAccessToken,
  resetRefreshCircuit,
  setRealtimeFetch,
  setSessionTokens,
} from '../authToken';

const API_URL = 'http://localhost:3000';

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  localStorage.clear();
  resetRefreshCircuit();
  setRealtimeFetch(vi.fn() as unknown as typeof fetch);
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

// ── Storage helpers ───────────────────────────────────────────────────────────

describe('token storage', () => {
  it('reads and writes the access token under the existing "token" key', () => {
    setSessionTokens('abc123');
    expect(getAccessToken()).toBe('abc123');
    expect(localStorage.getItem('token')).toBe('abc123');
  });

  it('round-trips a rotated refresh token', () => {
    setSessionTokens('new-access', 'new-refresh');
    expect(getAccessToken()).toBe('new-access');
    expect(getRefreshToken()).toBe('new-refresh');
  });

  it('keeps the previous refresh token when none is supplied', () => {
    setSessionTokens('a1', 'r1');
    setSessionTokens('a2');
    expect(getRefreshToken()).toBe('r1');
  });

  it('clears both tokens on session clear', () => {
    setSessionTokens('a1', 'r1');
    clearSession();
    expect(getAccessToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
  });

  it('returns null when nothing is stored', () => {
    expect(getAccessToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
  });
});

// ── Refresh without a refresh token ───────────────────────────────────────────

describe('refreshAccessToken — no refresh token', () => {
  it('fails without calling the network', async () => {
    const fetchMock = vi.fn();
    setRealtimeFetch(fetchMock as unknown as typeof fetch);

    const result = await refreshAccessToken();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('no_refresh_token');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not trip the circuit breaker', async () => {
    await refreshAccessToken();
    expect(getSessionState()).toBe('active');
  });
});

// ── Successful refresh ────────────────────────────────────────────────────────

describe('refreshAccessToken — success', () => {
  it('posts the refresh token and stores the rotated pair', async () => {
    setSessionTokens('old-access', 'refresh-1');
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ token: 'new-access', refreshToken: 'refresh-2' }));
    setRealtimeFetch(fetchMock as unknown as typeof fetch);

    const result = await refreshAccessToken();

    expect(result.ok).toBe(true);
    expect(result.token).toBe('new-access');
    expect(getAccessToken()).toBe('new-access');
    expect(getRefreshToken()).toBe('refresh-2');

    expect(fetchMock).toHaveBeenCalledWith(
      `${API_URL}/api/v1/auth/refresh`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ refreshToken: 'refresh-1' }),
      })
    );
  });

  it('tolerates a response without a rotated refresh token', async () => {
    setSessionTokens('old', 'refresh-1');
    setRealtimeFetch(
      vi.fn().mockResolvedValue(jsonResponse({ token: 'new-access' })) as unknown as typeof fetch
    );

    const result = await refreshAccessToken();

    expect(result.ok).toBe(true);
    expect(getRefreshToken()).toBe('refresh-1');
  });

  it('resets the failure counter after a success', async () => {
    setSessionTokens('a', 'r');
    setRealtimeFetch(
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({}),
      }) as unknown as typeof fetch
    );
    await refreshAccessToken({ maxAttempts: 1 });
    expect(getRefreshFailureCount()).toBeGreaterThan(0);

    setRealtimeFetch(
      vi.fn().mockResolvedValue(jsonResponse({ token: 'ok' })) as unknown as typeof fetch
    );
    const result = await refreshAccessToken({ maxAttempts: 1 });

    expect(result.ok).toBe(true);
    expect(getRefreshFailureCount()).toBe(0);
  });
});

// ── Rejected refresh token — the infinite-loop guard ──────────────────────────

describe('refreshAccessToken — rejected refresh token', () => {
  it('does not retry a 401 and instead latches into session-lost', async () => {
    setSessionTokens('a', 'stale-refresh');
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: { code: 'INVALID_TOKEN' } }, 401));
    setRealtimeFetch(fetchMock as unknown as typeof fetch);

    const result = await refreshAccessToken();

    expect(result.ok).toBe(false);
    expect(result.sessionLost).toBe(true);
    expect(result.error).toBe('refresh_rejected');
    // Exactly one attempt: retrying a rejected token is pointless.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getSessionState()).toBe('session-lost');
  });

  it('clears the session so the app can prompt for re-login', async () => {
    setSessionTokens('a', 'stale-refresh');
    setRealtimeFetch(vi.fn().mockResolvedValue(jsonResponse({}, 401)) as unknown as typeof fetch);

    await refreshAccessToken();

    expect(getAccessToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
  });

  it('treats 403 like 401 — the token is rejected either way', async () => {
    setSessionTokens('a', 'stale-refresh');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 403));
    setRealtimeFetch(fetchMock as unknown as typeof fetch);

    const result = await refreshAccessToken();

    expect(result.sessionLost).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('short-circuits subsequent refreshes once latched — no retry loop', async () => {
    setSessionTokens('a', 'stale-refresh');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 401));
    setRealtimeFetch(fetchMock as unknown as typeof fetch);

    await refreshAccessToken();
    const callsAfterFirst = fetchMock.mock.calls.length;

    // Five more attempts from other code paths must not hit the network.
    const second = await refreshAccessToken();
    const third = await refreshAccessToken();
    await refreshAccessToken();
    await refreshAccessToken();
    await refreshAccessToken();

    expect(second.ok).toBe(false);
    expect(second.sessionLost).toBe(true);
    expect(third.ok).toBe(false);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it('un-latches after an explicit reset (fresh login)', async () => {
    setSessionTokens('a', 'stale-refresh');
    setRealtimeFetch(vi.fn().mockResolvedValue(jsonResponse({}, 401)) as unknown as typeof fetch);
    await refreshAccessToken();
    expect(getSessionState()).toBe('session-lost');

    resetRefreshCircuit();
    setSessionTokens('a2', 'fresh-refresh');
    setRealtimeFetch(
      vi.fn().mockResolvedValue(jsonResponse({ token: 'good' })) as unknown as typeof fetch
    );

    const result = await refreshAccessToken();
    expect(result.ok).toBe(true);
    expect(getSessionState()).toBe('active');
  });
});

// ── Transient failures ────────────────────────────────────────────────────────

describe('refreshAccessToken — transient failures', () => {
  it('retries up to maxAttempts on 5xx, then reports failure', async () => {
    setSessionTokens('a', 'r');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 500));
    setRealtimeFetch(fetchMock as unknown as typeof fetch);

    const result = await refreshAccessToken({ maxAttempts: 3 });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('max_refresh_attempts');
    // Bounded: exactly maxAttempts network calls, never unbounded.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('keeps the session intact after transient failures', async () => {
    setSessionTokens('a', 'r');
    setRealtimeFetch(vi.fn().mockResolvedValue(jsonResponse({}, 500)) as unknown as typeof fetch);

    await refreshAccessToken({ maxAttempts: 2 });

    // A server blip must not log the user out — a later attempt can still
    // succeed, and the caller's backoff bounds how often we try.
    expect(getAccessToken()).toBe('a');
    expect(getRefreshToken()).toBe('r');
    expect(getSessionState()).not.toBe('session-lost');
  });

  it('surfaces refresh-failed while transient failures persist', async () => {
    setSessionTokens('a', 'r');
    setRealtimeFetch(vi.fn().mockResolvedValue(jsonResponse({}, 500)) as unknown as typeof fetch);

    await refreshAccessToken({ maxAttempts: 1 });

    expect(getSessionState()).toBe('refresh-failed');
  });

  it('retries on network exceptions', async () => {
    setSessionTokens('a', 'r');
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    setRealtimeFetch(fetchMock as unknown as typeof fetch);

    const result = await refreshAccessToken({ maxAttempts: 2 });

    expect(result.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('recovers when a later attempt succeeds', async () => {
    setSessionTokens('a', 'r');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse({ token: 'eventually' }));
    setRealtimeFetch(fetchMock as unknown as typeof fetch);

    const result = await refreshAccessToken({ maxAttempts: 3 });

    expect(result.ok).toBe(true);
    expect(getAccessToken()).toBe('eventually');
  });

  it('keeps each call bounded to maxAttempts even across repeated calls', async () => {
    setSessionTokens('a', 'r');
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'));
    setRealtimeFetch(fetchMock as unknown as typeof fetch);

    for (let i = 0; i < 20; i += 1) {
      await refreshAccessToken({ maxAttempts: 2 });
    }

    // 20 calls, each capped at 2 attempts → at most 40 network calls. The
    // total must stay linear in the number of callers, never exponential.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(40);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
  });

  it('treats a 200 with a malformed body as a failure', async () => {
    setSessionTokens('a', 'r');
    setRealtimeFetch(
      vi.fn().mockResolvedValue(jsonResponse({ nope: 1 })) as unknown as typeof fetch
    );

    const result = await refreshAccessToken({ maxAttempts: 2 });
    expect(result.ok).toBe(false);
  });

  it('defaults to DEFAULT_MAX_REFRESH_ATTEMPTS', () => {
    expect(DEFAULT_MAX_REFRESH_ATTEMPTS).toBe(3);
  });
});

// ── Single-flight ─────────────────────────────────────────────────────────────

describe('refreshAccessToken — single flight', () => {
  it('collapses concurrent callers into one network call', async () => {
    setSessionTokens('a', 'r');
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ token: 'shared', refreshToken: 'r2' }));
    setRealtimeFetch(fetchMock as unknown as typeof fetch);

    const results = await Promise.all([
      refreshAccessToken(),
      refreshAccessToken(),
      refreshAccessToken(),
      refreshAccessToken(),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const r of results) {
      expect(r.ok).toBe(true);
      expect(r.token).toBe('shared');
    }
  });

  it('allows a new refresh after the previous one settles', async () => {
    setSessionTokens('a', 'r');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ token: 't' }));
    setRealtimeFetch(fetchMock as unknown as typeof fetch);

    await refreshAccessToken();
    await refreshAccessToken();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ── authenticatedFetch ────────────────────────────────────────────────────────

describe('authenticatedFetch', () => {
  it('attaches the bearer token', async () => {
    setSessionTokens('token-abc');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: 1 }));
    setRealtimeFetch(fetchMock as unknown as typeof fetch);

    await authenticatedFetch(`${API_URL}/api/v1/notifications/sync`);

    const headers = new Headers(fetchMock.mock.calls[0][1].headers as HeadersInit);
    expect(headers.get('Authorization')).toBe('Bearer token-abc');
  });

  it('omits the header when there is no token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    setRealtimeFetch(fetchMock as unknown as typeof fetch);

    await authenticatedFetch(`${API_URL}/x`);

    const headers = new Headers(fetchMock.mock.calls[0][1].headers as HeadersInit);
    expect(headers.get('Authorization')).toBeNull();
  });

  it('preserves caller-supplied headers', async () => {
    setSessionTokens('t');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    setRealtimeFetch(fetchMock as unknown as typeof fetch);

    await authenticatedFetch(`${API_URL}/x`, { headers: { 'X-Trace': 'abc' } });

    const headers = new Headers(fetchMock.mock.calls[0][1].headers as HeadersInit);
    expect(headers.get('X-Trace')).toBe('abc');
    expect(headers.get('Authorization')).toBe('Bearer t');
  });

  it('refreshes once on 401 and replays the request', async () => {
    setSessionTokens('expired', 'refresh-1');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(jsonResponse({ token: 'fresh', refreshToken: 'refresh-2' }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));
    setRealtimeFetch(fetchMock as unknown as typeof fetch);

    const res = await authenticatedFetch(`${API_URL}/api/v1/notifications/sync`);

    expect(res.status).toBe(200);
    // original request + refresh + replay
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const replayHeaders = new Headers(fetchMock.mock.calls[2][1].headers as HeadersInit);
    expect(replayHeaders.get('Authorization')).toBe('Bearer fresh');
  });

  it('replays the request at most once — no 401/refresh loop', async () => {
    setSessionTokens('expired', 'refresh-1');
    // Every request 401s; refresh keeps succeeding.
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('/auth/refresh')) {
        return jsonResponse({ token: `t${Math.random()}`, refreshToken: `r${Math.random()}` });
      }
      return jsonResponse({}, 401);
    });
    setRealtimeFetch(fetchMock as unknown as typeof fetch);

    const res = await authenticatedFetch(`${API_URL}/api/v1/notifications/sync`);

    // 401 original + 1 refresh + 1 replay = 3. Never 5, never 7.
    expect(fetchMock.mock.calls.length).toBe(3);
    expect(res.status).toBe(401);
  });

  it('returns the original 401 when refresh fails', async () => {
    setSessionTokens('expired', 'bad-refresh');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValue(jsonResponse({}, 401));
    setRealtimeFetch(fetchMock as unknown as typeof fetch);

    const res = await authenticatedFetch(`${API_URL}/x`);

    expect(res.status).toBe(401);
  });

  it('can opt out of the refresh-and-retry', async () => {
    setSessionTokens('expired', 'r');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 401));
    setRealtimeFetch(fetchMock as unknown as typeof fetch);

    const res = await authenticatedFetch(`${API_URL}/x`, { retryOnUnauthorized: false });

    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('passes through non-401 errors without refreshing', async () => {
    setSessionTokens('t', 'r');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 500));
    setRealtimeFetch(fetchMock as unknown as typeof fetch);

    const res = await authenticatedFetch(`${API_URL}/x`);

    expect(res.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('forwards method and body', async () => {
    setSessionTokens('t');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    setRealtimeFetch(fetchMock as unknown as typeof fetch);

    await authenticatedFetch(`${API_URL}/x`, { method: 'POST', body: '{"a":1}' });

    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', body: '{"a":1}' });
  });
});
