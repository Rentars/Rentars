import type { Request, Response } from 'express';
import {
  syncAllBookings,
  syncAllProperties,
  syncBookingFromChain,
  syncPropertyFromChain,
} from '@/services/sync.service.js';
import {
  getReconciliationAttempts,
  forceReconciliationRetry,
  listOutboxNotifications,
} from '@/services/escrow-reconciliation.service.js';

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

export async function getReconciliationHandler(req: Request, res: Response): Promise<void> {
  const { bookingId } = req.params;
  const result = await getReconciliationAttempts(bookingId);

  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }
  res.json({
    bookingId,
    reconciliationState: result.data.reconciliationState,
    attempts: result.data.attempts,
  });
}

export async function retryReconciliationHandler(req: Request, res: Response): Promise<void> {
  const { bookingId } = req.params;
  const result = await forceReconciliationRetry(bookingId);

  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }
  res.json({
    message: `Reconciliation retry scheduled for booking ${bookingId}`,
    ...result.data,
  });
}

export async function listOutboxHandler(req: Request, res: Response): Promise<void> {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const result = await listOutboxNotifications({ status });

  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }
  res.json({ notifications: result.data.notifications });
}