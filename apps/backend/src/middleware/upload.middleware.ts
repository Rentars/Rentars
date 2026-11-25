import type { Request, Response, NextFunction } from 'express';
import { uploadImage } from '@/config/supabase-storage.js';
import { uploadRateLimiter } from '@/middleware/rateLimiter.middleware.js';

export async function uploadPropertyImage(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file provided' });
      return;
    }

    const propertyId = req.params.id;
    const publicUrl = await uploadImage(propertyId, req.file);

    res.json({ url: publicUrl });
  } catch (error) {
    next(error);
  }
}

/**
 * Upload-specific rate limiting middleware.
 *
 * Uploads have their own budget (separate from general API limits) and are
 * keyed by authenticated user ID where available. Anonymous callers fall back
 * to a trusted-proxy-derived IP key (never a raw, spoofable forwarding header).
 */
export const uploadRateLimit = uploadRateLimiter;