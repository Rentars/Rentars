import type { NextFunction, Response } from 'express';
import type { AuthRequest } from './auth.middleware.js';
import { supabase } from '@/config/supabase.js';

/**
 * Verifies the authenticated user owns the property at req.params.id.
 * Must be used after `authenticate`.
 */
export async function requirePropertyOwner(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const { id } = req.params;
  const userId = req.userId;

  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { data, error } = await supabase
    .from('properties')
    .select('owner_id')
    .eq('id', id)
    .single();

  if (error || !data) {
    res.status(404).json({ error: 'Property not found' });
    return;
  }

  if (data.owner_id !== userId) {
    res.status(403).json({ error: 'Forbidden: you do not own this property' });
    return;
  }

  next();
}

/**
 * Verifies the authenticated user owns the booking at req.params.id.
 * Must be used after `authenticate`.
 */
export async function requireBookingOwner(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const { id } = req.params;
  const userId = req.userId;

  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { data, error } = await supabase
    .from('bookings')
    .select('user_id')
    .eq('id', id)
    .single();

  if (error || !data) {
    res.status(404).json({ error: 'Booking not found' });
    return;
  }

  if (data.user_id !== userId) {
    res.status(403).json({ error: 'Forbidden: you do not own this booking' });
    return;
  }

  next();
}
