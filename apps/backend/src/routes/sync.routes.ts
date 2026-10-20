import { Router } from 'express';
import {
  syncAllBookingsHandler,
  syncAllPropertiesHandler,
  syncBookingHandler,
  syncPropertyHandler,
  getSyncLagHandler,
  listDeadLettersHandler,
  repairDeadLetterHandler,
} from '@/controllers/sync.controller.js';
import { authenticate } from '@/middleware/auth.middleware.js';

const router = Router();

// All sync endpoints require admin authentication
router.post('/property/:id', authenticate, syncPropertyHandler);
router.post('/booking/:id', authenticate, syncBookingHandler);
router.post('/properties', authenticate, syncAllPropertiesHandler);
router.post('/bookings', authenticate, syncAllBookingsHandler);

// Sync observability: lag metrics and dead-letter inspection/repair
router.get('/lag', authenticate, getSyncLagHandler);
router.get('/dead-letters', authenticate, listDeadLettersHandler);
router.post('/dead-letters/:id/repair', authenticate, repairDeadLetterHandler);

export default router;