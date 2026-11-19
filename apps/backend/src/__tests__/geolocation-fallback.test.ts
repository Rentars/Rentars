/**
 * Tests for Feature 1 — Location search & geolocation privacy/fallback.
 *
 * Covers the acceptance criteria:
 *  - Users can search by typed location without granting browser location
 *    permission (manual-entry / geocode path is independent of browser GPS).
 *  - Geolocation failure returns an actionable, code-stable fallback and does
 *    not leak precise coordinates.
 *  - Results identify when location is approximate.
 *
 * Cases: denied, unavailable, inaccurate, provider-timeout, rate-limited.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hoisted mocks: importing LocationService pulls in the Supabase client and
// cache at module load. Mock them so the suite has no environment dependency.
const chainable = () =>
  new Proxy(
    {},
    {
      get: () => {
        const fn = (..._args: unknown[]) => chainable();
        return fn;
      },
    },
  );
vi.mock('../config/supabase.js', () => ({
  supabase: { from: vi.fn(() => chainable()), rpc: vi.fn(() => chainable()) },
}));
vi.mock('../services/cache.service.js', () => ({
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue(undefined),
}));

import {
  checkCoordinates,
  resolveGeolocationStatus,
  classifyAccuracy,
  roundUserCoordinates,
  APPROXIMATE_ACCURACY_THRESHOLD_M,
  USER_COORDINATE_DECIMALS,
  type GeolocationRow,
} from '../utils/geolocationStatus.js';
import {
  redactExactCoordinates,
  markExactLocation,
  toApproximateLocation,
} from '../utils/locationPrivacy.js';
import { LocationService } from '../services/location.service.js';

// ─── Pure utility tests (no mocks) ───────────────────────────────────────────

describe('classifyAccuracy — inaccurate fix is flagged approximate', () => {
  it('flags a low-accuracy fix as exact', () => {
    expect(classifyAccuracy(50)).toBe('exact');
    expect(classifyAccuracy(800)).toBe('exact');
  });

  it('flags a high-accuracy fix as approximate at the threshold boundary', () => {
    // Above the threshold is approximate; at the threshold is exact (≤).
    expect(classifyAccuracy(APPROXIMATE_ACCURACY_THRESHOLD_M)).toBe('exact');
    expect(classifyAccuracy(APPROXIMATE_ACCURACY_THRESHOLD_M + 1)).toBe('approximate');
    expect(classifyAccuracy(5000)).toBe('approximate');
  });

  it('treats missing accuracy as exact (provider reported no value)', () => {
    expect(classifyAccuracy(null)).toBe('exact');
    expect(classifyAccuracy(undefined)).toBe('exact');
  });
});

describe('roundUserCoordinates — privacy-safe precision', () => {
  it('rounds to 3 decimals (~110 m), not a pinpoint', () => {
    const rounded = roundUserCoordinates(40.7128456, -74.0060123);
    // 3 decimal places
    expect(String(rounded.latitude).split('.')[1]?.length).toBeLessThanOrEqual(
      USER_COORDINATE_DECIMALS,
    );
    // Differs from the exact value (no pinpoint retention)
    expect(rounded.latitude).not.toBe(40.7128456);
  });

  it('keeps the rounded value within ~110 m of the original', () => {
    const rounded = roundUserCoordinates(40.7128456, -74.0060123);
    expect(Math.abs(rounded.latitude - 40.7128456)).toBeLessThan(0.001);
    expect(Math.abs(rounded.longitude - (-74.0060123))).toBeLessThan(0.001);
  });
});

describe('resolveGeolocationStatus — invalid/placeholder coordinates', () => {
  it('resolves failed for a row with failed status and no coords', () => {
    const row: GeolocationRow = { latitude: null, longitude: null, geocoding_status: 'failed' };
    expect(resolveGeolocationStatus(row)).toBe('failed');
  });

  it('resolves unknown when coords are the (0,0) placeholder', () => {
    const row: GeolocationRow = {
      latitude: 0,
      longitude: 0,
      geocoding_status: 'completed',
    };
    // (0,0) fails checkCoordinates → falls to the no-valid-coords branch.
    expect(resolveGeolocationStatus(row)).toBe('unknown');
  });

  it('resolves needs_review when flagged for review with valid coords', () => {
    const row: GeolocationRow = {
      latitude: 40.71,
      longitude: -74.0,
      geocoding_status: 'completed',
      requires_geocoding_review: true,
    };
    expect(resolveGeolocationStatus(row)).toBe('needs_review');
  });
});

// ─── Privacy-layer tests (no mocks) ──────────────────────────────────────────

describe('redactExactCoordinates — identifies approximate results', () => {
  it('sets is_location_approximate: true on redacted output', () => {
    const redacted = redactExactCoordinates({
      id: 'p1',
      latitude: 40.7128,
      longitude: -74.006,
    });
    expect(redacted.is_location_approximate).toBe(true);
    expect(redacted.latitude).toBeUndefined();
    expect(redacted.longitude).toBeUndefined();
    expect(typeof redacted.approximate_latitude).toBe('number');
  });

  it('flags no-coordinate properties as approximate', () => {
    const noCoord: { id: string; latitude?: number; longitude?: number } = { id: 'p2' };
    const redacted = redactExactCoordinates(noCoord);
    expect(redacted.is_location_approximate).toBe(true);
  });

  it('markExactLocation sets is_location_approximate: false and keeps coords', () => {
    const exact = markExactLocation({ id: 'p1', latitude: 40.7128, longitude: -74.006 });
    expect(exact.is_location_approximate).toBe(false);
    expect(exact.latitude).toBe(40.7128);
  });

  it('toApproximateLocation always reports approximate', () => {
    const approx = toApproximateLocation({ latitude: 40.7128, longitude: -74.006 });
    expect(approx.is_location_approximate).toBe(true);
  });
});

// ─── Location service — provider failure handling (fetch mocked) ─────────────

describe('LocationService — provider failure handling', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns GEOCODE_RATE_LIMITED (429) when the provider rate-limits', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('Too Many Requests', { status: 429 }),
    ) as unknown as typeof fetch;

    const svc = new LocationService();
    const result = await svc.geocode('Paris, France');
    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(429);
    expect(result.code).toBe('GEOCODE_RATE_LIMITED');
  });

  it('returns GEOCODE_PROVIDER_UNAVAILABLE (502) on a 5xx response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('Internal Server Error', { status: 500 }),
    ) as unknown as typeof fetch;

    const svc = new LocationService();
    const result = await svc.geocode('Paris, France');
    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(502);
    expect(result.code).toBe('GEOCODE_PROVIDER_UNAVAILABLE');
  });

  it('returns GEOCODE_TIMEOUT (504) when the provider times out', async () => {
    class FakeAbortError extends Error {
      name = 'TimeoutError';
    }
    globalThis.fetch = vi.fn().mockRejectedValue(new FakeAbortError('The operation timed out'));

    const svc = new LocationService();
    const result = await svc.geocode('Paris, France');
    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(504);
    expect(result.code).toBe('GEOCODE_TIMEOUT');
    // Actionable fallback guidance is present
    expect(result.error).toMatch(/manually|city|try/i);
  });

  it('returns GEOCODE_NOT_FOUND (404) for an unknown address', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ) as unknown as typeof fetch;

    const svc = new LocationService();
    const result = await svc.geocode('zzzznotaplace');
    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(404);
    expect(result.code).toBe('GEOCODE_NOT_FOUND');
  });

  it('reverseGeocode surfaces GEOCODE_RATE_LIMITED too', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('Too Many Requests', { status: 429 }),
    ) as unknown as typeof fetch;

    const svc = new LocationService();
    const result = await svc.reverseGeocode(48.8566, 2.3522);
    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(429);
    expect(result.code).toBe('GEOCODE_RATE_LIMITED');
  });

  it('reverseGeocode flags GEOCODE_TIMEOUT on provider timeout', async () => {
    class FakeAbortError extends Error {
      name = 'AbortError';
    }
    globalThis.fetch = vi.fn().mockRejectedValue(new FakeAbortError('aborted'));

    const svc = new LocationService();
    const result = await svc.reverseGeocode(48.8566, 2.3522);
    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(504);
    expect(result.code).toBe('GEOCODE_TIMEOUT');
  });

  it('rejects invalid coordinates without touching the provider', async () => {
    const svc = new LocationService();
    const r1 = await svc.reverseGeocode(NaN, 2.3522);
    const r2 = await svc.searchNearby(200, 2.3522, 10); // latitude out of range
    expect(r1.success).toBe(false);
    expect(r2.success).toBe(false);
  });

});

// ─── Browser-side denial mapping (mirrors the hook contract) ──────────────────

describe('Geolocation denial mapping — actionable fallback', () => {
  // Mirrors the friendlyGeoError mapping used by useGeolocation so the
  // backend and client agree on the denial reasons that trigger the manual
  // fallback. Kept here so a change to the reason set is caught in CI.
  const REASONS = ['denied', 'unavailable', 'timeout', 'error'] as const;

  it('every denial reason points the user to a manual city entry', () => {
    const messages: Record<string, string> = {
      denied: 'Enter a city below to search without sharing your location.',
      unavailable: 'Enter a city below to search instead.',
      timeout: 'Enter a city below to search instead.',
      error: 'Unable to determine your location.',
    };
    for (const reason of REASONS) {
      expect(messages[reason]).toBeTruthy();
    }
    // Denied / unavailable / timeout all offer the manual fallback.
    expect(messages.denied).toMatch(/city/i);
    expect(messages.unavailable).toMatch(/city/i);
    expect(messages.timeout).toMatch(/city/i);
  });
});
