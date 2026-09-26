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

export async function geocodeAddress(address: string): Promise<GeocodedLocation | null> {
  try {
    const res = await fetch(
      `${API_URL}/api/v1/locations/geocode?address=${encodeURIComponent(address)}`,
    );
    if (!res.ok) return null;
    const data = await res.json();
    return { lat: data.latitude, lng: data.longitude, address: data.address };
  } catch {
    return null;
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
