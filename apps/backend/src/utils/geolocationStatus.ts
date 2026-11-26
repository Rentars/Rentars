/**
 * Geolocation status rules for listings (issue #748).
 *
 * Every listing resolves to exactly one explicit status so that nearby search,
 * the host review queue and public responses never have to guess whether a
 * position is trustworthy.
 */

export const GEOLOCATION_STATUSES = [
  'verified',
  'completed',
  'needs_review',
  'pending',
  'failed',
  'unknown',
] as const;

export type GeolocationStatus = (typeof GEOLOCATION_STATUSES)[number];

/** Statuses whose coordinates may be used for nearby search results. */
const NEARBY_ELIGIBLE: ReadonlySet<GeolocationStatus> = new Set(['verified', 'completed']);

/**
 * Decimal places kept for coordinates in public responses. Two decimal places
 * is roughly 1.1 km of precision, which is enough to show a neighbourhood but
 * not an exact residential address.
 */
export const PUBLIC_COORDINATE_DECIMALS = 2;

/**
 * Browser geolocation accuracy (metres) above which a resolved position is
 * considered too imprecise for a precise nearby search and is flagged as
 * approximate. 1500 m matches the public-coordinate grid order of magnitude
 * so an approximate result is never presented as a pinpoint.
 */
export const APPROXIMATE_ACCURACY_THRESHOLD_M = 1500;

/**
 * Decimal places retained for user-supplied coordinates (browser geolocation)
 * before they are sent to the search API. Rounding to 3 decimals (~110 m)
 * keeps the search responsive without persisting a pinpoint that could
 * identify a residential address in logs or analytics.
 */
export const USER_COORDINATE_DECIMALS = 3;

/** Whether a coordinate-derived result should be presented as approximate. */
export type CoordinatePrecision = 'exact' | 'approximate';

export interface CoordinateCheck {
  valid: boolean;
  reason?: string;
}

export interface GeolocationRow {
  latitude?: number | string | null;
  longitude?: number | string | null;
  geocoding_status?: string | null;
  requires_geocoding_review?: boolean | null;
}

/**
 * Validate a latitude/longitude pair. Accepts numbers or numeric strings
 * (database DECIMAL columns come back as strings), rejects anything non-finite
 * or out of range, and rejects the exact (0, 0) point, which is almost always a
 * placeholder written by a failed import rather than a real listing location.
 */
export function checkCoordinates(latitude: unknown, longitude: unknown): CoordinateCheck {
  const lat = toNumber(latitude);
  const lng = toNumber(longitude);

  if (lat === null || lng === null) {
    return { valid: false, reason: 'Coordinates must be numeric' };
  }
  if (lat < -90 || lat > 90) {
    return { valid: false, reason: 'Latitude must be between -90 and 90' };
  }
  if (lng < -180 || lng > 180) {
    return { valid: false, reason: 'Longitude must be between -180 and 180' };
  }
  if (lat === 0 && lng === 0) {
    return { valid: false, reason: 'Coordinates (0, 0) are a placeholder, not a location' };
  }
  return { valid: true };
}

/**
 * Resolve the explicit geolocation status for a listing row.
 *
 * Precedence:
 * 1. Invalid or missing coordinates → `failed` / `pending` if the geocoder
 *    recorded that state, otherwise `unknown`.
 * 2. Valid coordinates flagged for review → `needs_review`.
 * 3. Otherwise the stored status, if it is one we recognise, else `unknown`.
 */
export function resolveGeolocationStatus(row: GeolocationRow): GeolocationStatus {
  const stored = row.geocoding_status ?? null;
  const hasValidCoordinates = checkCoordinates(row.latitude, row.longitude).valid;

  if (!hasValidCoordinates) {
    if (stored === 'failed') return 'failed';
    if (stored === 'pending') return 'pending';
    return 'unknown';
  }

  if (row.requires_geocoding_review) return 'needs_review';

  if (stored === 'verified' || stored === 'completed') return stored;
  return 'unknown';
}

/**
 * Whether a listing with this status may appear in nearby search. Unknown,
 * pending, failed and low-confidence positions are excluded so the distance
 * shown to a guest is never computed from an unreliable point.
 */
export function isNearbyEligible(status: GeolocationStatus): boolean {
  return NEARBY_ELIGIBLE.has(status);
}

/**
 * Round coordinates for a public response. Exact residential coordinates must
 * not leak; callers that need exact positions (hosts, admins) should not use
 * this helper.
 */
export function roundPublicCoordinates(
  latitude: number,
  longitude: number,
  decimals = PUBLIC_COORDINATE_DECIMALS
): { latitude: number; longitude: number } {
  const factor = 10 ** decimals;
  return {
    latitude: Math.round(latitude * factor) / factor,
    longitude: Math.round(longitude * factor) / factor,
  };
}

/**
 * Classify whether a browser-geolocation accuracy value (in metres) is
 * precise enough for an exact nearby search.  Positions above the threshold
 * are flagged `approximate` so results can be presented with an uncertainty
 * indicator and not treated as a pinpoint.
 *
 * A null/undefined accuracy is treated as exact — it means the provider did
 * not report one, not that the position is known to be coarse.
 */
export function classifyAccuracy(accuracyM: number | null | undefined): CoordinatePrecision {
  if (accuracyM == null) return 'exact';
  return accuracyM <= APPROXIMATE_ACCURACY_THRESHOLD_M ? 'exact' : 'approximate';
}

/**
 * Round a user-supplied coordinate pair (e.g. from browser geolocation) to a
 * privacy-safe precision before it is used in a search request or written to
 * any log/analytics payload.  Three decimal places is ~110 m — enough for a
 * responsive nearby search without persisting a residential pinpoint.
 */
export function roundUserCoordinates(
  latitude: number,
  longitude: number,
  decimals = USER_COORDINATE_DECIMALS,
): { latitude: number; longitude: number } {
  const factor = 10 ** decimals;
  return {
    latitude: Math.round(latitude * factor) / factor,
    longitude: Math.round(longitude * factor) / factor,
  };
}

/**
 * Whether a failed geocoder call should be retried. Rate limiting, server
 * errors and network failures are transient; other client errors (for example
 * a malformed request) will not succeed on retry.
 */
export function isRetryableGeocodingFailure(httpStatus: number | 'network'): boolean {
  if (httpStatus === 'network') return true;
  return httpStatus === 429 || httpStatus >= 500;
}

/**
 * Maximum radius (in kilometres) accepted by nearby search. Anything larger is
 * rejected rather than silently clamped so callers get a clear error instead of
 * a query that scans the whole table.
 */
export const MAX_SEARCH_RADIUS_KM = 500;

/** Default radius used when the caller does not supply one. */
export const DEFAULT_SEARCH_RADIUS_KM = 25;

export interface FieldError {
  field: string;
  message: string;
}

export interface GeospatialSearchInput {
  latitude?: unknown;
  longitude?: unknown;
  radiusKm?: unknown;
}

export interface GeospatialSearchValidation {
  valid: boolean;
  errors: FieldError[];
  /** Present only when `valid` is true. */
  value?: { latitude: number; longitude: number; radiusKm: number };
}

/**
 * Validate the geospatial portion of an advanced search request.
 *
 * Latitude and longitude must be supplied as a pair; supplying only one is a
 * field-level error rather than a silent fallback to a non-geospatial search.
 * Poles (±90) and the antimeridian (±180) are valid. The exact (0, 0) point is
 * rejected because it is almost always a placeholder. Radius must be a finite
 * number greater than zero and no larger than MAX_SEARCH_RADIUS_KM.
 */
export function validateGeospatialSearch(
  input: GeospatialSearchInput
): GeospatialSearchValidation {
  const errors: FieldError[] = [];
  const hasLat = input.latitude !== undefined && input.latitude !== null && input.latitude !== '';
  const hasLng =
    input.longitude !== undefined && input.longitude !== null && input.longitude !== '';

  if (hasLat !== hasLng) {
    errors.push({
      field: hasLat ? 'longitude' : 'latitude',
      message: 'Latitude and longitude must be provided together',
    });
  }

  let lat: number | null = null;
  let lng: number | null = null;

  if (hasLat && hasLng) {
    lat = toNumber(input.latitude);
    lng = toNumber(input.longitude);

    if (lat === null) {
      errors.push({ field: 'latitude', message: 'Latitude must be a finite number' });
    } else if (lat < -90 || lat > 90) {
      errors.push({ field: 'latitude', message: 'Latitude must be between -90 and 90' });
    }

    if (lng === null) {
      errors.push({ field: 'longitude', message: 'Longitude must be a finite number' });
    } else if (lng < -180 || lng > 180) {
      errors.push({ field: 'longitude', message: 'Longitude must be between -180 and 180' });
    }

    if (lat !== null && lng !== null && lat === 0 && lng === 0) {
      errors.push({
        field: 'latitude',
        message: 'Coordinates (0, 0) are a placeholder, not a location',
      });
    }
  }

  let radiusKm = DEFAULT_SEARCH_RADIUS_KM;
  const hasRadius =
    input.radiusKm !== undefined && input.radiusKm !== null && input.radiusKm !== '';

  if (hasRadius) {
    const parsed = toNumber(input.radiusKm);
    if (parsed === null) {
      errors.push({ field: 'radiusKm', message: 'Radius must be a finite number' });
    } else if (parsed <= 0) {
      errors.push({ field: 'radiusKm', message: 'Radius must be greater than 0' });
    } else if (parsed > MAX_SEARCH_RADIUS_KM) {
      errors.push({
        field: 'radiusKm',
        message: `Radius must not exceed ${MAX_SEARCH_RADIUS_KM} km`,
      });
    } else {
      radiusKm = parsed;
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    errors: [],
    value: { latitude: lat as number, longitude: lng as number, radiusKm },
  };
}

/**
 * Whether a search request carries any geospatial intent. When it does not, the
 * search must run as a plain non-geospatial query: missing coordinates must
 * never exclude unrelated results or crash the request.
 */
export function hasGeospatialIntent(input: GeospatialSearchInput): boolean {
  const present = (v: unknown) => v !== undefined && v !== null && v !== '';
  return present(input.latitude) || present(input.longitude) || present(input.radiusKm);
}

/**
 * Whether the geospatial schema (PostGIS extension, geometry column and its
 * spatial index) is available. When it is not, callers should fall back to a
 * non-geospatial search rather than erroring.
 */
export function isGeospatialSchemaAvailable(schema: {
  postgisInstalled?: boolean | null;
  geometryColumnPresent?: boolean | null;
  spatialIndexPresent?: boolean | null;
}): boolean {
  return Boolean(
    schema.postgisInstalled && schema.geometryColumnPresent && schema.spatialIndexPresent
  );
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
