import type { Request, Response } from 'express';
import { LocationService } from '@/services/location.service.js';
import type { ServiceResponse } from '@/services/index.js';

const locationService = new LocationService();

/**
 * Send a failed ServiceResponse as an HTTP error, preserving the stable
 * `code` discriminator so the frontend can render an actionable fallback
 * (manual city entry, retry) instead of a generic message.
 */
function sendLocationError(res: Response, result: ServiceResponse<unknown>): void {
  if (!result.success) {
    res.status(result.statusCode || 400).json({ error: result.error, code: result.code });
  }
}

export async function reverseGeocodeAddress(req: Request, res: Response): Promise<void> {
  const { lat, lng } = req.query;

  const result = await locationService.reverseGeocode(
    parseFloat(lat as string),
    parseFloat(lng as string),
  );

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

  const result = await locationService.searchNearby(
    parseFloat(lat as string),
    parseFloat(lng as string),
    parseFloat((radius as string) || '10'),
  );

  if (!result.success) {
    sendLocationError(res, result);
    return;
  }

  res.json(result.data);
}

export async function getPriceComparison(req: Request, res: Response): Promise<void> {
  const { lat, lng, radius } = req.query;

  const result = await locationService.getPriceComparison(
    parseFloat(lat as string),
    parseFloat(lng as string),
    parseFloat((radius as string) || '10'),
  );

  if (!result.success) {
    sendLocationError(res, result);
    return;
  }

  res.json(result.data);
}
