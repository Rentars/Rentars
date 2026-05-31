import { supabase } from '../config/supabase.js';
import type { ServiceResponse } from './index.js';

export interface Coordinates {
  lat: number;
  lng: number;
}

export interface GeocodingResult {
  coordinates: Coordinates;
  display_name: string;
  city?: string;
  country?: string;
  postcode?: string;
}

export interface LocationSearchResult {
  id: string;
  title: string;
  address?: string;
  city?: string;
  country?: string;
  coordinates?: Coordinates;
  price_per_night?: number;
  distance_km?: number;
}

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';

export async function geocodeAddress(
  address: string,
): Promise<ServiceResponse<GeocodingResult>> {
  if (!address) return { success: false, error: 'Address is required' };

  const url = `${NOMINATIM_BASE}/search?q=${encodeURIComponent(address)}&format=json&limit=1&addressdetails=1`;

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Rentars/1.0' },
    });

    if (!response.ok) return { success: false, error: 'Geocoding service unavailable' };

    const results = (await response.json()) as Record<string, unknown>[];

    if (!results.length) return { success: false, error: 'Address not found' };

    const result = results[0] as Record<string, unknown>;
    const addr = result.address as Record<string, string> | undefined;

    return {
      success: true,
      data: {
        coordinates: {
          lat: parseFloat(result.lat as string),
          lng: parseFloat(result.lon as string),
        },
        display_name: result.display_name as string,
        city: addr?.city ?? addr?.town ?? addr?.village,
        country: addr?.country,
        postcode: addr?.postcode,
      },
    };
  } catch {
    return { success: false, error: 'Failed to geocode address' };
  }
}

export async function reverseGeocode(
  lat: number,
  lng: number,
): Promise<ServiceResponse<GeocodingResult>> {
  if (lat === undefined || lng === undefined) {
    return { success: false, error: 'Coordinates are required' };
  }

  const url = `${NOMINATIM_BASE}/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1`;

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Rentars/1.0' },
    });

    if (!response.ok) return { success: false, error: 'Reverse geocoding service unavailable' };

    const result = (await response.json()) as Record<string, unknown>;

    if (result.error) return { success: false, error: result.error as string };

    const addr = result.address as Record<string, string> | undefined;

    return {
      success: true,
      data: {
        coordinates: { lat, lng },
        display_name: result.display_name as string,
        city: addr?.city ?? addr?.town ?? addr?.village,
        country: addr?.country,
        postcode: addr?.postcode,
      },
    };
  } catch {
    return { success: false, error: 'Failed to reverse geocode coordinates' };
  }
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export async function searchPropertiesByLocation(
  lat: number,
  lng: number,
  radiusKm: number = 10,
): Promise<ServiceResponse<LocationSearchResult[]>> {
  if (lat === undefined || lng === undefined) {
    return { success: false, error: 'Coordinates are required' };
  }

  const latDelta = radiusKm / 111;
  const lngDelta = radiusKm / (111 * Math.cos((lat * Math.PI) / 180));

  const { data, error } = await supabase
    .from('properties')
    .select('id, title, address, city, country, price_per_night, latitude, longitude')
    .gte('latitude', lat - latDelta)
    .lte('latitude', lat + latDelta)
    .gte('longitude', lng - lngDelta)
    .lte('longitude', lng + lngDelta)
    .eq('status', 'available');

  if (error) return { success: false, error: error.message };

  type Row = {
    id: string;
    title: string;
    address?: string;
    city?: string;
    country?: string;
    price_per_night?: number;
    latitude?: number;
    longitude?: number;
  };

  const results: LocationSearchResult[] = (data as Row[])
    .map((p) => {
      const distance_km =
        p.latitude !== undefined && p.longitude !== undefined
          ? haversineKm(lat, lng, p.latitude, p.longitude)
          : undefined;
      return {
        id: p.id,
        title: p.title,
        address: p.address,
        city: p.city,
        country: p.country,
        price_per_night: p.price_per_night,
        coordinates:
          p.latitude !== undefined && p.longitude !== undefined
            ? { lat: p.latitude, lng: p.longitude }
            : undefined,
        distance_km,
      };
    })
    .filter((p) => p.distance_km === undefined || p.distance_km <= radiusKm)
    .sort((a, b) => (a.distance_km ?? 0) - (b.distance_km ?? 0));

  return { success: true, data: results };
}
