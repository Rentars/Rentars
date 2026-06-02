import type { Request, Response } from 'express';
import type { AuthRequest } from '@/middleware/auth.middleware.js';
import {
  getAvailabilityRanges,
  blockAvailabilityRange,
  deleteAvailabilityRange,
  checkDateRangeAvailability,
} from '@/services/availability.service.js';

/** GET /api/v1/properties/:id/availability — all blocked ranges */
export async function getAvailability(req: Request, res: Response): Promise<void> {
  const result = await getAvailabilityRanges(req.params.id);
  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

/** GET /api/v1/properties/:id/availability/check?check_in=&check_out= — full availability window */
export async function checkAvailabilityWindow(req: Request, res: Response): Promise<void> {
  const { check_in, check_out } = req.query as { check_in?: string; check_out?: string };

  if (!check_in || !check_out) {
    res.status(400).json({ error: 'check_in and check_out query parameters are required' });
    return;
  }

  const result = await checkDateRangeAvailability(req.params.id, check_in, check_out);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

/** POST /api/v1/properties/:id/availability — block a date range (host only) */
export async function addAvailabilityBlock(req: AuthRequest, res: Response): Promise<void> {
  const result = await blockAvailabilityRange(req.params.id, req.userId!, req.body);
  if (!result.success) {
    const status = result.error?.startsWith('Forbidden') ? 403 : 400;
    res.status(status).json({ error: result.error });
    return;
  }
  res.status(201).json(result.data);
}

/** DELETE /api/v1/properties/:id/availability/:rangeId — remove a blocked range (host only) */
export async function removeAvailabilityBlock(req: AuthRequest, res: Response): Promise<void> {
  const result = await deleteAvailabilityRange(req.params.id, req.params.rangeId, req.userId!);
  if (!result.success) {
    const status = result.error?.startsWith('Forbidden') ? 403 : 404;
    res.status(status).json({ error: result.error });
    return;
  }
  res.status(204).send();
}
