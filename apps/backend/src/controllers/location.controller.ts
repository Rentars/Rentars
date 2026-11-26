import type { Request, Response } from 'express';
import { LocationService } from '@/services/location.service.js';
import {
  validateCoordinatePair,
  validateRadius,
  type FieldErrors,
} from '@/validators/geospatial.validator.js';

const locationService = new LocationService();

function sendValidationErrors(res: Response, errors: FieldErrors): void {
  res.status(422).json({ error: 'Invalid geospatial parameters', fields: errors });
}

export async function reverseGeocodeAddress(req: Request, res: Response): Promise<void> {
  const { lat, lng } = req.query;

  const coordinates = validateCoordinatePair(lat, lng);
  if (!coordinates.valid) {
    sendValidationErrors(res, coordinates.errors);
    return;
  }

  const result = await locationService.reverseGeocode(coordinates.lat, coordinates.lng);

  if (!result.success) {
    sendLocationError(res, result);
    return;
  }

  res.json(result.data);
}

export async function geocodeAddress(req: Request, res: Response): Promise<void> {
  const { address } = req.query;

  const result = await locationService.geocode(address as string);

  if (!result.success) {
    sendLocationError(res, result);
    return;
  }

  res.json(result.data);
}

export async function searchNearby(req: Request, res: Response): Promise<void> {
  const { lat, lng, radius } = req.query;

  const coordinates = validateCoordinatePair(lat, lng);
  const radiusResult = validateRadius(radius);
  if (!coordinates.valid || !radiusResult.valid) {
    sendValidationErrors(res, {
      ...(coordinates.valid ? {} : coordinates.errors),
      ...(radiusResult.valid ? {} : radiusResult.errors),
    });
    return;
  }

  const result = await locationService.searchNearby(
    coordinates.lat,
    coordinates.lng,
    radiusResult.radius,
  );

  if (!result.success) {
    sendLocationError(res, result);
    return;
  }

  // Nearby listings are a public endpoint: never expose exact residential
  // coordinates or private address fields from LocationService.
  res.json(redactPublicLocationResponse(result.data, { tier: 'public' }));
}

export async function getPriceComparison(req: Request, res: Response): Promise<void> {
  const { lat, lng, radius } = req.query;

  const coordinates = validateCoordinatePair(lat, lng);
  const radiusResult = validateRadius(radius);
  if (!coordinates.valid || !radiusResult.valid) {
    sendValidationErrors(res, {
      ...(coordinates.valid ? {} : coordinates.errors),
      ...(radiusResult.valid ? {} : radiusResult.errors),
    });
    return;
  }

  const result = await locationService.getPriceComparison(
    coordinates.lat,
    coordinates.lng,
    radiusResult.radius,
  );

  if (!result.success) {
    sendLocationError(res, result);
    return;
  }

  res.json(result.data);
}
