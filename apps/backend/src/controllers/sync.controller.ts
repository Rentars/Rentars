import type { Request, Response } from 'express';
import {
  syncAllBookings,
  syncAllProperties,
  syncBookingFromChain,
  syncPropertyFromChain,
  getSyncLag,
  listDeadLetters,
  repairDeadLetter,
} from '@/services/sync.service.js';

export async function syncPropertyHandler(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const result = await syncPropertyFromChain(id);

  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }
  res.json({ message: `Property ${id} synced successfully` });
}

export async function syncBookingHandler(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const result = await syncBookingFromChain(id);

  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }
  res.json({ message: `Booking ${id} synced successfully` });
}

export async function syncAllPropertiesHandler(_req: Request, res: Response): Promise<void> {
  const result = await syncAllProperties();

  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }
  res.json({ message: 'All properties synced', ...result.data });
}

export async function syncAllBookingsHandler(_req: Request, res: Response): Promise<void> {
  const result = await syncAllBookings();

  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }
  res.json({ message: 'All bookings synced', ...result.data });
}

export async function syncLagHandler(_req: Request, res: Response): Promise<void> {
  const result = await getSyncLag();

  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }
  res.json({
    cursor: result.data.cursor,
    pendingCount: result.data.pendingCount,
    lag: result.data.lag,
    lastProcessedAt: result.data.lastProcessedAt,
  });
}

export async function listDeadLettersHandler(req: Request, res: Response): Promise<void> {
  const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
  const offset = req.query.offset !== undefined ? Number(req.query.offset) : undefined;

  if (
    (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) ||
    (offset !== undefined && (!Number.isInteger(offset) || offset < 0))
  ) {
    res.status(400).json({ error: 'Invalid limit or offset' });
    return;
  }

  const result = await listDeadLetters({ limit, offset });

  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }
  res.json({
    events: result.data.events,
    total: result.data.total,
    limit: result.data.limit,
    offset: result.data.offset,
  });
}

export async function repairDeadLetterHandler(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const result = await repairDeadLetter(id);

  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }
  res.json({ message: `Dead-letter event ${id} repaired`, ...result.data });
}