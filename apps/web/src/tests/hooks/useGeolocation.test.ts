import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useGeolocation } from '@/hooks/useGeolocation';

// ── Mock useLocationSearch (reverse geocode + manual geocode) ────────────────
vi.mock('@/hooks/useLocationSearch', () => ({
  reverseGeocodeCoords: vi.fn(),
  geocodeAddressDetailed: vi.fn(),
}));

import { reverseGeocodeCoords, geocodeAddressDetailed } from '@/hooks/useLocationSearch';
const mockReverseGeocode = vi.mocked(reverseGeocodeCoords);
const mockGeocodeDetailed = vi.mocked(geocodeAddressDetailed);

// ── Geolocation API mock helpers ─────────────────────────────────────────────
function mockGeolocationSuccess(lat = 51.505, lng = -0.09, accuracy = 10) {
  const getCurrentPosition = vi.fn((onSuccess: PositionCallback) => {
    onSuccess({
      coords: {
        latitude: lat,
        longitude: lng,
        accuracy,
        altitude: null,
        altitudeAccuracy: null,
        heading: null,
        speed: null,
      },
      timestamp: Date.now(),
    } as GeolocationPosition);
  });
  Object.defineProperty(navigator, 'geolocation', {
    value: { getCurrentPosition },
    writable: true,
    configurable: true,
  });
  return getCurrentPosition;
}

function mockGeolocationError(code: number, message: string) {
  const getCurrentPosition = vi.fn(
    (_: PositionCallback, onError: PositionErrorCallback) => {
      onError({ code, message, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as GeolocationPositionError);
    },
  );
  Object.defineProperty(navigator, 'geolocation', {
    value: { getCurrentPosition },
    writable: true,
    configurable: true,
  });
}

function removeGeolocation() {
  Object.defineProperty(navigator, 'geolocation', {
    value: undefined,
    writable: true,
    configurable: true,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('useGeolocation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('starts idle with null position/label/error and not loading', () => {
      const { result } = renderHook(() => useGeolocation());
      expect(result.current.position).toBeNull();
      expect(result.current.label).toBeNull();
      expect(result.current.error).toBeNull();
      expect(result.current.loading).toBe(false);
      expect(result.current.permission).toBe('idle');
    });
  });

  describe('successful location + reverse geocode', () => {
    it('resolves position and label, calls onLocation, and grants permission', async () => {
      mockGeolocationSuccess(51.505, -0.09);
      mockReverseGeocode.mockResolvedValue({ label: 'London, England, United Kingdom' });

      const onLocation = vi.fn();
      const { result } = renderHook(() => useGeolocation({ onLocation }));

      act(() => { result.current.requestLocation(); });

      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.position).toMatchObject({
        lat: 51.505,
        lng: -0.09,
        is_approximate: false,
        source: 'browser',
      });
      expect(result.current.label).toBe('London, England, United Kingdom');
      expect(result.current.error).toBeNull();
      expect(result.current.permission).toBe('granted');
      expect(onLocation).toHaveBeenCalledOnce();
      expect(onLocation).toHaveBeenCalledWith(
        expect.objectContaining({ lat: 51.505, lng: -0.09, is_approximate: false, source: 'browser' }),
        'London, England, United Kingdom',
      );
    });

    it('calls reverseGeocodeCoords with the rounded coordinates', async () => {
      mockGeolocationSuccess(48.8566123, 2.3522123);
      mockReverseGeocode.mockResolvedValue({ label: 'Paris, Île-de-France, France' });

      const { result } = renderHook(() => useGeolocation());
      act(() => { result.current.requestLocation(); });

      await waitFor(() => expect(result.current.loading).toBe(false));

      // Coords are rounded to 3 decimals (~110 m) before being sent on.
      expect(mockReverseGeocode).toHaveBeenCalledWith(48.857, 2.352);
    });

    it('flags a low-accuracy fix as approximate', async () => {
      mockGeolocationSuccess(10, 10, 5000); // accuracy 5 km > 1500 m threshold
      mockReverseGeocode.mockResolvedValue({ label: 'Somewhere' });

      const { result } = renderHook(() => useGeolocation());
      act(() => { result.current.requestLocation(); });

      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.position?.is_approximate).toBe(true);
    });

    it('sets label to null and still calls onLocation when reverse geocode returns null', async () => {
      mockGeolocationSuccess(0, 0);
      mockReverseGeocode.mockResolvedValue(null);

      const onLocation = vi.fn();
      const { result } = renderHook(() => useGeolocation({ onLocation }));

      act(() => { result.current.requestLocation(); });

      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.position).toMatchObject({ lat: 0, lng: 0, source: 'browser' });
      expect(result.current.label).toBeNull();
      expect(onLocation).toHaveBeenCalledWith(expect.objectContaining({ lat: 0, lng: 0 }), null);
    });

    it('sets label to null when reverse geocode rejects', async () => {
      mockGeolocationSuccess(10, 10);
      mockReverseGeocode.mockRejectedValue(new Error('network error'));

      const { result } = renderHook(() => useGeolocation());
      act(() => { result.current.requestLocation(); });

      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.position).toMatchObject({ lat: 10, lng: 10 });
      expect(result.current.label).toBeNull();
    });
  });

  describe('manual location fallback (no browser permission)', () => {
    it('resolves a typed city to an approximate position without requesting permission', async () => {
      // Simulate a browser/permission that is unavailable — the manual path
      // must still work without ever touching navigator.geolocation.
      removeGeolocation();
      mockGeocodeDetailed.mockResolvedValue({
        data: { lat: 48.8566, lng: 2.3522, address: 'Paris, France' },
        error: null,
      });

      const onLocation = vi.fn();
      const { result } = renderHook(() => useGeolocation({ onLocation }));

      await act(async () => {
        await result.current.enterManualLocation('Paris');
      });

      expect(result.current.position).toMatchObject({
        lat: 48.857,
        lng: 2.352,
        is_approximate: true,
        source: 'manual',
      });
      expect(result.current.label).toBe('Paris, France');
      expect(result.current.permission).toBe('idle');
      // No browser geolocation was requested.
      expect(navigator.geolocation).toBeUndefined();
      expect(onLocation).toHaveBeenCalledWith(
        expect.objectContaining({ is_approximate: true, source: 'manual' }),
        'Paris, France',
      );
    });

    it('surfaces an actionable error when the geocoder fails', async () => {
      mockGeocodeDetailed.mockResolvedValue({
        data: null,
        error: { message: 'That location was not found.', code: 'GEOCODE_NOT_FOUND' },
      });

      const { result } = renderHook(() => useGeolocation());
      await act(async () => {
        await result.current.enterManualLocation('zzzznotaplace');
      });

      expect(result.current.position).toBeNull();
      expect(result.current.error).toMatch(/not found|try/i);
    });
  });

  describe('permission denial', () => {
    it('sets a friendly error and a denied permission state with no position', async () => {
      mockGeolocationError(1, 'User denied Geolocation');

      const { result } = renderHook(() => useGeolocation());
      act(() => { result.current.requestLocation(); });

      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.position).toBeNull();
      expect(result.current.label).toBeNull();
      expect(result.current.error).toMatch(/denied/i);
      expect(result.current.permission).toBe('denied');
    });
  });

  describe('position unavailable', () => {
    it('sets a friendly unavailable message', async () => {
      mockGeolocationError(2, 'Position unavailable');

      const { result } = renderHook(() => useGeolocation());
      act(() => { result.current.requestLocation(); });

      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.error).toMatch(/unavailable/i);
      expect(result.current.permission).toBe('unavailable');
    });
  });

  describe('timeout', () => {
    it('sets a friendly timeout message', async () => {
      mockGeolocationError(3, 'Timeout');

      const { result } = renderHook(() => useGeolocation());
      act(() => { result.current.requestLocation(); });

      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.error).toMatch(/timed out/i);
      expect(result.current.permission).toBe('timeout');
    });
  });

  describe('geolocation unsupported', () => {
    it('sets an unsupported error without calling getCurrentPosition', () => {
      removeGeolocation();

      const { result } = renderHook(() => useGeolocation());
      act(() => { result.current.requestLocation(); });

      expect(result.current.error).toMatch(/not supported/i);
      expect(result.current.loading).toBe(false);
      expect(result.current.permission).toBe('unavailable');
      expect(mockReverseGeocode).not.toHaveBeenCalled();
    });
  });

  describe('loading state', () => {
    it('is true while waiting for geolocation', () => {
      Object.defineProperty(navigator, 'geolocation', {
        value: { getCurrentPosition: vi.fn() },
        writable: true,
        configurable: true,
      });

      const { result } = renderHook(() => useGeolocation());
      act(() => { result.current.requestLocation(); });

      expect(result.current.loading).toBe(true);
      expect(result.current.permission).toBe('prompting');
    });
  });
});
