import type { Response } from 'express';
import type { AuthRequest } from '@/middleware/auth.middleware.js';
import { BookingService } from '@/services/booking.service.js';

const bookingService = new BookingService();

export async function getBooking(req: AuthRequest, res: Response): Promise<void> {
  const result = await bookingService.getBookingById(req.params.id);

  if (!result.success) {
    res.status(404).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

export async function createBooking(req: AuthRequest, res: Response): Promise<void> {
  const result = await bookingService.createBooking({ ...req.body, user_id: req.userId });

  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.status(201).json(result.data);
}

export async function cancelBooking(req: AuthRequest, res: Response): Promise<void> {
  const result = await bookingService.cancelBooking(req.params.id, req.userId ?? '');

  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

export async function confirmBooking(req: AuthRequest, res: Response): Promise<void> {
  const result = await bookingService.confirmBooking(req.params.id, req.userId ?? '');

  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

export async function updateBooking(req: AuthRequest, res: Response): Promise<void> {
  const result = await bookingService.updateBooking(req.params.id, req.body);

  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

export async function deleteBooking(req: AuthRequest, res: Response): Promise<void> {
  const result = await bookingService.deleteBooking(req.params.id);

  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.status(204).send();
}
