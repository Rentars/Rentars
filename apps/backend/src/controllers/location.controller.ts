import type { Request, Response } from 'express';
import {
  geocodeAddress,
  reverseGeocode,
  searchPropertiesByLocation,
} from '../services/location.service.js';

export async function geocodeHandler(req: Request, res: Response): Promise<void> {
  const { address, lat, lng } = req.query;

  if (lat && lng) {
    const result = await reverseGeocode(Number(lat), Number(lng));
    if (!result.success) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json(result.data);
    return;
  }

  if (!address) {
    res.status(400).json({ error: 'Provide address or lat/lng query params' });
    return;
  }

  const result = await geocodeAddress(address as string);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

export async function locationSearchHandler(req: Request, res: Response): Promise<void> {
  const { lat, lng, radius } = req.query;

  if (!lat || !lng) {
    res.status(400).json({ error: 'lat and lng are required' });
    return;
  }

  const result = await searchPropertiesByLocation(
    Number(lat),
    Number(lng),
    radius ? Number(radius) : 10,
  );

  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }
  res.json(result.data);
}
