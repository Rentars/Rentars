import { supabase } from '@/config/supabase.js';
import * as cache from './cache.service.js';
import type { ServiceResponse } from './index.js';

/**
 * Documented geospatial search policy.
 *
 * - Coordinates are WGS-84 degrees.
 * - Latitude must be within [-90, 90]; longitude within [-180, 180].
 * - Coordinates are rounded to 4 decimal places (~11 m) before use so that
 *   near-identical inputs share cache entries and query plans.
 * - Radius is expressed in kilometres, must be strictly positive and may not
 *   exceed {@link MAX_SEARCH_RADIUS_KM}.
 */
export const MAX_SEARCH_RADIUS_KM = 500;
export const MIN_SEARCH_RADIUS_KM = 0.001;
export const COORDINATE_PRECISION_DP = 4;

/** Field-level validation errors keyed by input field name. */
export type GeoFieldErrors = Record<string, string>;

export interface ValidatedGeoQuery {
  lat: number;
  lng: number;
  radiusKm: number;
}

export type GeoValidationResult =
  | { ok: true; value: ValidatedGeoQuery }
  | { ok: false; fields: GeoFieldErrors };

/** Round a coordinate to the documented precision. */
export function roundCoordinate(value: number): number {
  const factor = 10 ** COORDINATE_PRECISION_DP;
  return Math.round(value * factor) / factor;
}

/**
 * Validate a latitude/longitude pair and radius as a single unit.
 *
 * Latitude and longitude must be supplied together: providing only one is a
 * field-level error on the missing field. Non-finite values (NaN, Infinity)
 * and out-of-range values are rejected. The radius is validated against the
 * documented policy bounds.
 */
export function validateGeoQuery(input: {
  lat?: number | string | null;
  lng?: number | string | null;
  radiusKm?: number | string | null;
}): GeoValidationResult {
  const fields: GeoFieldErrors = {};

  const hasLat = input.lat !== undefined && input.lat !== null && input.lat !== '';
  const hasLng = input.lng !== undefined && input.lng !== null && input.lng !== '';

  const lat = hasLat ? Number(input.lat) : NaN;
  const lng = hasLng ? Number(input.lng) : NaN;

  if (!hasLat && !hasLng) {
    fields.lat = 'Latitude is required when longitude is provided';
    fields.lng = 'Longitude is required when latitude is provided';
  } else if (hasLat && !hasLng) {
    fields.lng = 'Longitude is required when latitude is provided';
  } else if (!hasLat && hasLng) {
    fields.lat = 'Latitude is required when longitude is provided';
  }

  if (hasLat) {
    if (!Number.isFinite(lat)) {
      fields.lat = 'Latitude must be a finite number';
    } else if (lat < -90 || lat > 90) {
      fields.lat = 'Latitude must be between -90 and 90';
    }
  }

  if (hasLng) {
    if (!Number.isFinite(lng)) {
      fields.lng = 'Longitude must be a finite number';
    } else if (lng < -180 || lng > 180) {
      fields.lng = 'Longitude must be between -180 and 180';
    }
  }

  const hasRadius = input.radiusKm !== undefined && input.radiusKm !== null && input.radiusKm !== '';
  const radiusKm = hasRadius ? Number(input.radiusKm) : NaN;

  if (!hasRadius) {
    fields.radiusKm = 'Radius is required';
  } else if (!Number.isFinite(radiusKm)) {
    fields.radiusKm = 'Radius must be a finite number';
  } else if (radiusKm < MIN_SEARCH_RADIUS_KM) {
    fields.radiusKm = `Radius must be at least ${MIN_SEARCH_RADIUS_KM} km`;
  } else if (radiusKm > MAX_SEARCH_RADIUS_KM) {
    fields.radiusKm = `Radius must not exceed ${MAX_SEARCH_RADIUS_KM} km`;
  }

  if (Object.keys(fields).length > 0) {
    return { ok: false, fields };
  }

  return {
    ok: true,
    value: {
      lat: roundCoordinate(lat),
      lng: roundCoordinate(lng),
      radiusKm,
    },
  };
}

export interface GeocodeResult {
=======
  latitude: number;
  longitude: number;
  address: string;
}

export interface ReverseGeocodeResult {
  label: string;
}

/** Reverse-geocode cache TTL: 1 hour. Coordinates rarely change their place name. */
const REVERSE_GEOCODE_TTL = 3600;

/** Forward geocode cache TTL: 5 minutes. */
const GEOCODE_TTL = 300;

export interface PropertyWithDistance {
  id: string;
  title: string;
  latitude: number;
  longitude: number;
  price_per_night: number;
  distance_km?: number;
}

export interface PriceComparison {
  property_id: string;
  title: string;
  price_per_night: number;
  distance_km: number;
  price_rank: number;
  avg_area_price: number;
  price_diff_pct: number;
}

/**
 * Map a thrown geocoder error to an actionable, code-stable ServiceResponse.
 *
 * The Nominatim fetch uses `AbortSignal.timeout`, so a slow provider surfaces
 * as an `AbortError`/`TimeoutError` rather than a generic failure. Distinguishing
 * the timeout lets the UI offer a "try again" fallback instead of reporting an
 * opaque internal error.
 */
function classifyGeocodeError(error: unknown, label: string): ServiceResponse<never> {
  const name = error instanceof Error ? error.name : '';
  const isTimeout =
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    (error instanceof Error && /timed? ?out/i.test(error.message));
  if (isTimeout) {
    return {
      success: false,
      error: `${label} timed out. The location provider did not respond in time — try again or enter a city manually.`,
      statusCode: 504,
      code: 'GEOCODE_TIMEOUT',
    };
  }
  const message = error instanceof Error ? error.message : `${label} failed`;
  return {
    success: false,
    error: `${label} failed. You can still search by typing a city or address.`,
    statusCode: 502,
    code: 'GEOCODE_PROVIDER_UNAVAILABLE',
    details: process.env.NODE_ENV === 'test' ? message : undefined,
  };
}

export class LocationService {
  /**
   * Reverse-geocode a coordinate pair to a human-readable address label.
   * Results are cached in Redis for {@link REVERSE_GEOCODE_TTL} seconds.
   *
   * @param lat - WGS-84 latitude
   * @param lng - WGS-84 longitude
   */
  async reverseGeocode(lat: number, lng: number): Promise<ServiceResponse<ReverseGeocodeResult>> {
    if (isNaN(lat) || isNaN(lng)) {
      return { success: false, error: 'Invalid latitude or longitude', statusCode: 400 };
    }
    if (lat < -90 || lat > 90) {
      return { success: false, error: 'Latitude must be between -90 and 90', statusCode: 400 };
    }
    if (lng < -180 || lng > 180) {
      return { success: false, error: 'Longitude must be between -180 and 180', statusCode: 400 };
    }

    // Round to 4 dp (~11 m precision) to maximise cache hits for near-identical coords.
    const roundedLat = Math.round(lat * 10000) / 10000;
    const roundedLng = Math.round(lng * 10000) / 10000;
    const cacheKey = `reverse-geocode:${roundedLat}:${roundedLng}`;

    const cached = await cache.get<ReverseGeocodeResult>(cacheKey);
    if (cached) return { success: true, data: cached };

    try {
      const url =
        `https://nominatim.openstreetmap.org/reverse?lat=${roundedLat}&lon=${roundedLng}&format=json`;
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Rentars/1.0 (rentals platform)' },
        signal: AbortSignal.timeout(10_000),
      });

      if (response.status === 429) {
        return {
          success: false,
          error: 'Reverse geocoding rate limit exceeded. Try again in a moment.',
          statusCode: 429,
          code: 'GEOCODE_RATE_LIMITED',
        };
      }
      if (!response.ok) {
        return {
          success: false,
          error: 'Reverse geocoding service is temporarily unavailable.',
          statusCode: 502,
          code: 'GEOCODE_PROVIDER_UNAVAILABLE',
        };
      }

      const data = (await response.json()) as {
        display_name?: string;
        error?: string;
        address?: {
          city?: string;
          town?: string;
          village?: string;
          county?: string;
          state?: string;
          country?: string;
        };
      };

      if (data.error || !data.display_name) {
        return {
          success: false,
          error: 'Location not found. Enter a city or address manually.',
          statusCode: 404,
          code: 'GEOCODE_NOT_FOUND',
        };
      }

      // Build a concise label: "City, State, Country" falling back to display_name.
      const a = data.address ?? {};
      const city = a.city ?? a.town ?? a.village ?? a.county ?? '';
      const parts = [city, a.state, a.country].filter(Boolean);
      const label = parts.length >= 2 ? parts.join(', ') : data.display_name;

      const result: ReverseGeocodeResult = { label };
      await cache.set(cacheKey, result, REVERSE_GEOCODE_TTL);
      return { success: true, data: result };
    } catch (error) {
      return classifyGeocodeError(error, 'Reverse geocoding');
    }
  }

  async geocode(address: string): Promise<ServiceResponse<GeocodeResult>> {
    if (!address || address.trim() === '') {
      return {
        success: false,
        error: 'Address is required',
        statusCode: 400,
        code: 'GEOCODE_INVALID_INPUT',
      };
    }

    const cacheKey = `geocode:${address.trim().toLowerCase()}`;
    const cached = await cache.get<GeocodeResult>(cacheKey);
    if (cached) return { success: true, data: cached };

    try {
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1`;
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Rentars/1.0 (rentals platform)' },
        signal: AbortSignal.timeout(10_000),
      });

      if (response.status === 429) {
        return {
          success: false,
          error: 'Geocoding rate limit exceeded. Try again in a moment.',
          statusCode: 429,
          code: 'GEOCODE_RATE_LIMITED',
        };
      }
      if (!response.ok) {
        return {
          success: false,
          error: 'Geocoding service is temporarily unavailable. Enter a city manually instead.',
          statusCode: 502,
          code: 'GEOCODE_PROVIDER_UNAVAILABLE',
        };
      }

      const results = (await response.json()) as Array<{
        lat: string;
        lon: string;
        display_name: string;
      }>;

      if (!results.length) {
        return {
          success: false,
          error: 'Address not found. Try a more specific city or address.',
          statusCode: 404,
          code: 'GEOCODE_NOT_FOUND',
        };
      }

      const [hit] = results;
      const result: GeocodeResult = {
        latitude: parseFloat(hit.lat),
        longitude: parseFloat(hit.lon),
        address: hit.display_name,
      };

      await cache.set(cacheKey, result, GEOCODE_TTL);
      return { success: true, data: result };
    } catch (error) {
      return classifyGeocodeError(error, 'Geocoding');
    }
  }

  async searchNearby(
    lat: number,
    lng: number,
    radius: number,
  ): Promise<ServiceResponse<PropertyWithDistance[]>> {
    const validation = validateGeoQuery({ lat, lng, radiusKm: radius });
    if (!validation.ok) {
      return {
        success: false,
        error: 'Invalid geospatial search parameters',
        statusCode: 422,
        fields: validation.fields,
      };
    }

    const { lat: safeLat, lng: safeLng, radiusKm } = validation.value;

    try {
      const { data, error } = await supabase.rpc('search_nearby_properties', {
        lat: safeLat,
        lng: safeLng,
        radius_km: radiusKm,
      });

      if (error) {
        // Fallback: filter in JS when PostGIS RPC is not available
        return await this.nearbyFallback(safeLat, safeLng, radiusKm);
      }

      return { success: true, data: data || [] };
    } catch (error) {
      // A thrown error (e.g. missing PostGIS schema) should not fail the
      // search outright; degrade to the JS-side haversine fallback.
      try {
        return await this.nearbyFallback(safeLat, safeLng, radiusKm);
      } catch (fallbackError) {
        const message =
          fallbackError instanceof Error ? fallbackError.message : 'Search failed';
        return { success: false, error: message, statusCode: 500 };
      }
    }
  }

  async getPriceComparison(
    lat: number,
    lng: number,
    radius: number,
  ): Promise<ServiceResponse<PriceComparison[]>> {
    const nearbyResult = await this.searchNearby(lat, lng, radius);
    if (!nearbyResult.success || !nearbyResult.data?.length) {
      return { success: true, data: [] };
    }

    const properties = nearbyResult.data;
    const prices = properties.map((p) => p.price_per_night);
    const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;

    const sorted = [...properties].sort((a, b) => a.price_per_night - b.price_per_night);
    const comparisons: PriceComparison[] = sorted.map((p, i) => ({
      property_id: p.id,
      title: p.title,
      price_per_night: p.price_per_night,
      distance_km: p.distance_km ?? 0,
      price_rank: i + 1,
      avg_area_price: Math.round(avgPrice * 100) / 100,
      price_diff_pct: Math.round(((p.price_per_night - avgPrice) / avgPrice) * 100 * 10) / 10,
    }));

    return { success: true, data: comparisons };
  }

  /** JS-side haversine fallback when PostGIS is not configured */
  private async nearbyFallback(
    lat: number,
    lng: number,
    radius: number,
  ): Promise<ServiceResponse<PropertyWithDistance[]>> {
    const { data, error } = await supabase
      .from('properties')
      .select('id, title, latitude, longitude, price_per_night')
      .not('latitude', 'is', null)
      .not('longitude', 'is', null);

    if (error) return { success: false, error: error.message, statusCode: 500 };

    const R = 6371;
    const nearby = (data as PropertyWithDistance[])
      .filter(
        (p) =>
          Number.isFinite(p.latitude) &&
          Number.isFinite(p.longitude) &&
          p.latitude >= -90 &&
          p.latitude <= 90 &&
          p.longitude >= -180 &&
          p.longitude <= 180,
      )
      .map((p) => {
        const dLat = ((p.latitude - lat) * Math.PI) / 180;
        const dLng = ((p.longitude - lng) * Math.PI) / 180;
        const a =
          Math.sin(dLat / 2) ** 2 +
          Math.cos((lat * Math.PI) / 180) *
            Math.cos((p.latitude * Math.PI) / 180) *
            Math.sin(dLng / 2) ** 2;
        const distance_km = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return { ...p, distance_km: Math.round(distance_km * 100) / 100 };
      })
      .filter((p) => p.distance_km <= radius)
      .sort((a, b) => (a.distance_km ?? 0) - (b.distance_km ?? 0));

    return { success: true, data: nearby };
  }
}
