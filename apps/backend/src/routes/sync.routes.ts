import { Router } from 'express';
import {
  syncAllBookingsHandler,
  syncAllPropertiesHandler,
  syncBookingHandler,
  syncPropertyHandler,
} from '@/controllers/sync.controller.js';
import {
  getReconciliationStatusHandler,
  retryReconciliationHandler,
  getOutboxHandler,
} from '@/controllers/reconciliation.controller.js';
import { authenticate } from '@/middleware/auth.middleware.js';

const router = Router();

// All sync endpoints require admin authentication
router.post('/property/:id', authenticate, syncPropertyHandler);
router.post('/booking/:id', authenticate, syncBookingHandler);
router.post('/properties', authenticate, syncAllPropertiesHandler);
router.post('/bookings', authenticate, syncAllBookingsHandler);

// Escrow reconciliation admin endpoints
router.get('/reconciliation/:bookingId', authenticate, getReconciliationStatusHandler);
router.post('/reconciliation/:bookingId/retry', authenticate, retryReconciliationHandler);

// Notification outbox admin endpoint
router.get('/outbox', authenticate, getOutboxHandler);

export default router;