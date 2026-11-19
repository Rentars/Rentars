'use client';

import { useCallback, useRef, useState } from 'react';
import { geocodeAddressDetailed, reverseGeocodeCoords } from './useLocationSearch';

export interface GeoPosition {
  lat: number;
  lng: number;
  /** Position accuracy in metres as reported by the browser, if available. */
  accuracy?: number;
  /**
   * True when the position is not precise enough to treat as a pinpoint
   * (low-accuracy browser fix) or was resolved from a manual city entry.
   * Consumers should present these results as approximate.
   */
  is_approximate: boolean;
  /** How the position was obtained: browser geolocation or manual entry. */
  source: 'browser' | 'manual';
}

export type GeolocationPermissionState =
  | 'idle'
  | 'prompting'
  | 'granted'
  | 'denied'
  | 'unavailable'
  | 'timeout'
  | 'error';

export interface GeolocationState {
  position: GeoPosition | null;
  /** Human-readable place label resolved by reverse geocoding, or null. */
  label: string | null;
  error: string | null;
  /** Actionable, code-stable failure reason so the UI can render a fallback. */
  errorReason: GeolocationPermissionState | null;
  loading: boolean;
  permission: GeolocationPermissionState;
}

export interface UseGeolocationOptions {
  /**
   * Called once coordinates AND a resolved label are available.
   * `label` is null when reverse geocoding failed (position is still valid).
   */
  onLocation?: (position: GeoPosition, label: string | null) => void;
}

/**
 * Decimal places retained for user-supplied coordinates before they leave the
 * hook. Three decimals (~110 m) is enough for a responsive nearby search
 * without persisting a residential pinpoint in client state or analytics.
 */
const USER_COORDINATE_DECIMALS = 3;

/**
 * Browser accuracy (metres) above which a fix is flagged approximate.
 * Mirrors the backend APPROXIMATE_ACCURACY_THRESHOLD_M so the client and
 * server agree on what "approximate" means.
 */
const APPROXIMATE_ACCURACY_THRESHOLD_M = 1500;

function roundCoord(value: number, decimals = USER_COORDINATE_DECIMALS): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Map browser GeolocationPositionError codes to friendly messages. */
function friendlyGeoError(err: GeolocationPositionError): {
  message: string;
  reason: GeolocationPermissionState;
} {
  switch (err.code) {
    case err.PERMISSION_DENIED:
      return {
        message: 'Location access was denied. Enter a city below to search without sharing your location.',
        reason: 'denied',
      };
    case err.POSITION_UNAVAILABLE:
      return {
        message: 'Your location is currently unavailable. Enter a city below to search instead.',
        reason: 'unavailable',
      };
    case err.TIMEOUT:
      return {
        message: 'Location request timed out. Enter a city below to search instead.',
        reason: 'timeout',
      };
    default:
      return { message: err.message || 'Unable to determine your location.', reason: 'error' };
  }
}

export function useGeolocation(options: UseGeolocationOptions = {}) {
  const { onLocation } = options;
  const onLocationRef = useRef(onLocation);
  onLocationRef.current = onLocation;

  const [state, setState] = useState<GeolocationState>({
    position: null,
    label: null,
    error: null,
    errorReason: null,
    loading: false,
    permission: 'idle',
  });

  /**
   * Request the browser's location. Only called after an intentional action
   * (button click) so the permission prompt never appears unprompted.
   */
  const requestLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setState({
        position: null,
        label: null,
        error: 'Geolocation is not supported by your browser. Enter a city below to search instead.',
        errorReason: 'unavailable',
        loading: false,
        permission: 'unavailable',
      });
      return;
    }

    setState({
      position: null,
      label: null,
      error: null,
      errorReason: null,
      loading: true,
      permission: 'prompting',
    });

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const accuracy = pos.coords.accuracy;
        const isApproximate =
          accuracy != null ? accuracy > APPROXIMATE_ACCURACY_THRESHOLD_M : false;

        // Privacy-safe rounding: never expose a pinpoint beyond search precision.
        const position: GeoPosition = {
          lat: roundCoord(pos.coords.latitude),
          lng: roundCoord(pos.coords.longitude),
          accuracy,
          is_approximate: isApproximate,
          source: 'browser',
        };

        setState({
          position,
          label: null,
          error: null,
          errorReason: null,
          loading: true,
          permission: 'granted',
        });

        // Reverse geocoding is best-effort: a provider failure must never break
        // the location fix or leak an unhandled rejection. Fall back to no label.
        let label: string | null = null;
        try {
          const result = await reverseGeocodeCoords(position.lat, position.lng);
          label = result?.label ?? null;
        } catch {
          label = null;
        }

        setState({
          position,
          label,
          error: null,
          errorReason: null,
          loading: false,
          permission: 'granted',
        });
        onLocationRef.current?.(position, label);
      },
      (err) => {
        const { message, reason } = friendlyGeoError(err);
        setState({
          position: null,
          label: null,
          error: message,
          errorReason: reason,
          loading: false,
          permission: reason,
        });
      },
      { timeout: 10000, maximumAge: 60000, enableHighAccuracy: false },
    );
  }, []);

  /**
   * Manual location fallback: resolve a typed city/address to coordinates
   * without requesting browser permission. The resulting position is always
   * flagged approximate (city-level), so consumers present it accordingly.
   */
  const enterManualLocation = useCallback(async (cityOrAddress: string) => {
    const trimmed = cityOrAddress.trim();
    if (!trimmed) {
      setState((s) => ({
        ...s,
        error: 'Enter a city or address to search by location.',
        errorReason: 'idle',
      }));
      return;
    }

    setState((s) => ({
      ...s,
      error: null,
      errorReason: null,
      loading: true,
    }));

    const result = await geocodeAddressDetailed(trimmed);
    if (!result.data) {
      setState((s) => ({
        ...s,
        position: null,
        label: null,
        error: result.error?.message ?? 'Could not find that location. Try a different city or address.',
        errorReason: 'error',
        loading: false,
        permission: s.permission === 'idle' ? 'idle' : s.permission,
      }));
      return;
    }

    const { lat, lng, address } = result.data;
    const position: GeoPosition = {
      lat: roundCoord(lat),
      lng: roundCoord(lng),
      // City-level geocode has no meaningful accuracy; treat as approximate.
      is_approximate: true,
      source: 'manual',
    };

    setState({
      position,
      label: address,
      error: null,
      errorReason: null,
      loading: false,
      permission: 'idle',
    });
    onLocationRef.current?.(position, address);
  }, []);

  const reset = useCallback(() => {
    setState({
      position: null,
      label: null,
      error: null,
      errorReason: null,
      loading: false,
      permission: 'idle',
    });
  }, []);

  return { ...state, requestLocation, enterManualLocation, reset };
}
