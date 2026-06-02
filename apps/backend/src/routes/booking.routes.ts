import { Router } from 'express';
import {
  createBooking,
  deleteBooking,
  getBooking,
  updateBooking,
} from '@/controllers/booking.controller.js';
import { authenticate } from '@/middleware/auth.middleware.js';
import { requireBookingOwner } from '@/middleware/rbac.middleware.js';
import { bookingRateLimiter } from '@/middleware/rateLimiter.js';
import {
  createBookingSchema,
  updateBookingSchema,
  validateBody,
} from '@/validators/booking.validator.js';

const router = Router();

// GET /api/v1/bookings/:id
router.get('/:id', authenticate, getBooking);

// POST /api/v1/bookings
router.post('/', authenticate, bookingRateLimiter, validateBody(createBookingSchema), createBooking);

// PATCH /api/v1/bookings/:id  — owner only
router.patch('/:id', authenticate, requireBookingOwner, validateBody(updateBookingSchema), updateBooking);

// DELETE /api/v1/bookings/:id  — owner only
router.delete('/:id', authenticate, requireBookingOwner, deleteBooking);

export default router;
