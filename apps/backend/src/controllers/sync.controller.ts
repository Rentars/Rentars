import type { Request, Response } from 'express';
import {
  syncAllBookings,
  syncAllProperties,
  syncBookingFromChain,
  syncPropertyFromChain,
} from '@/services/sync.service.js';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

interface PageParams {
  cursor: string | undefined;
  pageSize: number;
}

function parsePageParams(req: Request): PageParams | { error: string } {
  const rawCursor = req.query.cursor;
  const rawPageSize = req.query.pageSize ?? req.query.limit;

  let cursor: string | undefined;
  if (rawCursor !== undefined) {
    if (typeof rawCursor !== 'string') {
      return { error: 'cursor must be a single string value' };
    }
    const trimmed = rawCursor.trim();
    if (trimmed.length > 0) {
      cursor = trimmed;
    }
  }

  let pageSize = DEFAULT_PAGE_SIZE;
  if (rawPageSize !== undefined) {
    if (typeof rawPageSize !== 'string') {
      return { error: 'pageSize must be a single string value' };
    }
    const parsed = Number.parseInt(rawPageSize, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return { error: 'pageSize must be a positive integer' };
    }
    pageSize = Math.min(parsed, MAX_PAGE_SIZE);
  }

  return { cursor, pageSize };
}

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

export async function syncAllPropertiesHandler(req: Request, res: Response): Promise<void> {
  const params = parsePageParams(req);
  if ('error' in params) {
    res.status(400).json({ error: params.error });
    return;
  }

  const result = await syncAllProperties({
    cursor: params.cursor,
    pageSize: params.pageSize,
  });

  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }
  res.json({ message: 'Properties page synced', ...result.data });
}

export async function syncAllBookingsHandler(req: Request, res: Response): Promise<void> {
  const params = parsePageParams(req);
  if ('error' in params) {
    res.status(400).json({ error: params.error });
    return;
  }

  const result = await syncAllBookings({
    cursor: params.cursor,
    pageSize: params.pageSize,
  });

  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }
  res.json({ message: 'Bookings page synced', ...result.data });
}