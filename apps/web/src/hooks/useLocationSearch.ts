'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Property } from '@/types/property';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

export interface NearbySearchParams {
  lat: number;
  lng: number;
  radius?: number; // km, default 10
}

export function useNearbyProperties(params: NearbySearchParams | null) {
  const [properties, setProperties] = useState<Property[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetch_ = useCallback(async (p: NearbySearchParams) => {
    setIsLoading(true);
    setError(null);
    try {
      const radius = p.radius ?? 10;
      const url = `${API_URL}/api/v1/locations/search?lat=${p.lat}&lng=${p.lng}&radius=${radius}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('Failed to fetch nearby properties');
      const data = await res.json();
      setProperties(data ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load nearby properties');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (params) fetch_(params);
  }, [params, fetch_]);

  return { properties, isLoading, error };
}

export interface GeocodedLocation {
  lat: number;
  lng: number;
  address: string;
}

/** Actionable geocoder failure surfaced to the UI for the manual-location fallback. */
export interface GeocodeError {
  message: string;
  /** Stable code from the backend (GEOCODE_RATE_LIMITED, GEOCODE_TIMEOUT, …). */
  code?: string;
}

export interface GeocodeResultDetail {
  data: GeocodedLocation | null;
  error: GeocodeError | null;
}

/** Friendly, code-aware message for a backend geocode error response. */
function describeGeocodeError(code: string | undefined, fallback: string): string {
  switch (code) {
    case 'GEOCODE_RATE_LIMITED':
      return 'The location service is busy right now. Try again in a moment, or enter a different city.';
    case 'GEOCODE_TIMEOUT':
      return 'The location service timed out. Try again, or enter a different city.';
    case 'GEOCODE_PROVIDER_UNAVAILABLE':
      return 'The location service is temporarily unavailable. Enter a city manually to search instead.';
    case 'GEOCODE_NOT_FOUND':
      return 'That location was not found. Try a more specific city or address.';
    default:
      return fallback;
  }
}

export async function geocodeAddress(address: string): Promise<GeocodedLocation | null> {
  const result = await geocodeAddressDetailed(address);
  return result.data;
}

/**
 * Forward-geocode an address and return an actionable error when the provider
 * fails, so the UI can render a manual-entry fallback with a specific message
 * rather than a generic "failed".
 */
export async function geocodeAddressDetailed(address: string): Promise<GeocodeResultDetail> {
  try {
    const res = await fetch(
      `${API_URL}/api/v1/locations/geocode?address=${encodeURIComponent(address)}`,
    );
    if (!res.ok) {
      let code: string | undefined;
      try {
        code = ((await res.json()) as { code?: string }).code;
      } catch {
        /* ignore parse failure */
      }
      const message = describeGeocodeError(code, 'Failed to search for that location.');
      return { data: null, error: { message, code } };
    }
    const data = (await res.json()) as { latitude?: number; longitude?: number; address?: string };
    if (data.latitude == null || data.longitude == null) {
      return { data: null, error: { message: 'That location was not found.', code: 'GEOCODE_NOT_FOUND' } };
    }
    return {
      data: { lat: data.latitude, lng: data.longitude, address: data.address ?? address },
      error: null,
    };
  } catch {
    return {
      data: null,
      error: { message: 'Network error reaching the location service. Enter a city to search instead.', code: 'GEOCODE_PROVIDER_UNAVAILABLE' },
    };
  }
}

export interface ReverseGeocodedLocation {
  label: string;
}

/**
 * Resolve a coordinate pair to a human-readable place label via the backend
 * reverse-geocode endpoint (which caches results in Redis).
 *
 * Returns `null` on network error or when the server cannot identify the location.
 */
export async function reverseGeocodeCoords(
  lat: number,
  lng: number,
): Promise<ReverseGeocodedLocation | null> {
  try {
    const res = await fetch(
      `${API_URL}/api/v1/locations/reverse-geocode?lat=${lat}&lng=${lng}`,
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.label) return null;
    return { label: data.label as string };
  } catch {
    return null;
  }
}

export interface UseLocationSearchOptions {
  onLocationSelected?: (location: GeocodedLocation) => void;
}

export function useLocationSearch(options: UseLocationSearchOptions = {}) {
  const { onLocationSelected } = options;
  const [input, setInput] = useState('');
  const [suggestions, setSuggestions] = useState<GeocodedLocation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const searchLocations = useCallback(async (query: string) => {
    const trimmedQuery = query.trim();

    if (!trimmedQuery) {
      setSuggestions([]);
      setLoading(false);
      setError(null);
      return;
    }

    if (trimmedQuery.length < 2) {
      setSuggestions([]);
      setError(null);
      setLoading(false);
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (abortRef.current) abortRef.current.abort();

    setLoading(true);
    setError(null);

    const controller = new AbortController();
    abortRef.current = controller;

    debounceRef.current = setTimeout(async () => {
      try {
        const location = await geocodeAddress(trimmedQuery);
        if (!controller.signal.aborted && location) {
          setSuggestions([location]);
        } else if (!controller.signal.aborted) {
          setSuggestions([]);
        }
      } catch {
        if (!controller.signal.aborted) {
          setError('Failed to search locations');
          setSuggestions([]);
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }, 300);
  }, []);

  const selectLocation = useCallback((location: GeocodedLocation) => {
    setInput(location.address);
    setSuggestions([]);
    onLocationSelected?.(location);
  }, [onLocationSelected]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  return {
    input,
    setInput,
    suggestions,
    loading,
    error,
    searchLocations,
    selectLocation,
  };
}
