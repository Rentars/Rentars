import type { Request, Response } from 'express';
import {
  syncAllBookings,
  syncAllProperties,
  syncBookingFromChain,
  syncPropertyFromChain,
} from '@/services/sync.service.js';
import { getCorrelationContext } from '@/middleware/correlation.middleware.js';

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
  const context = getCorrelationContext(req);
  const result = await syncPropertyFromChain(id, context);

  if (!result.success) {
    res.status(500).json({ error: result.error, correlation_id: context.correlationId });
    return;
  }
  res.json({
    message: `Property ${id} synced successfully`,
    correlation_id: context.correlationId,
    operation_id: context.operationId,
  });
}

export async function syncBookingHandler(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const context = getCorrelationContext(req, { bookingId: id });
  const result = await syncBookingFromChain(id, context);

  if (!result.success) {
    res.status(500).json({
      error: result.error,
      correlation_id: context.correlationId,
      booking_id: context.bookingId,
    });
    return;
  }
  res.json({
    message: `Booking ${id} synced successfully`,
    correlation_id: context.correlationId,
    booking_id: context.bookingId,
    operation_id: context.operationId,
  });
}

export async function syncAllPropertiesHandler(req: Request, res: Response): Promise<void> {
  const context = getCorrelationContext(req);
  const params = parsePageParams(req);
  if ('error' in params) {
    res.status(400).json({ error: params.error, correlation_id: context.correlationId });
    return;
  }

  const result = await syncAllProperties(context, {
    cursor: params.cursor,
    pageSize: params.pageSize,
  });

  if (!result.success) {
    res.status(500).json({ error: result.error, correlation_id: context.correlationId });
    return;
  }
  res.json({
    message: 'Properties page synced',
    ...result.data,
    correlation_id: context.correlationId,
    operation_id: context.operationId,
  });
}

export async function syncAllBookingsHandler(req: Request, res: Response): Promise<void> {
  const context = getCorrelationContext(req);
  const params = parsePageParams(req);
  if ('error' in params) {
    res.status(400).json({ error: params.error, correlation_id: context.correlationId });
    return;
  }

  const result = await syncAllBookings(context, {
    cursor: params.cursor,
    pageSize: params.pageSize,
  });

  if (!result.success) {
    res.status(500).json({ error: result.error, correlation_id: context.correlationId });
    return;
  }
  res.json({
    message: 'Bookings page synced',
    ...result.data,
    correlation_id: context.correlationId,
    operation_id: context.operationId,
  });
}