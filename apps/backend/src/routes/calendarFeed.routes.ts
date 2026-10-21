import { Router } from 'express';
import { getCalendarFeed } from '@/controllers/booking.controller.js';

const router = Router();

// Public endpoint — authenticated via persistent DB token embedded in the URL.
// The token format is a 64-char hex string; the .ics suffix is stripped in the
// controller so calendar apps that append it automatically still work.
//
// GET /api/v1/calendar/feed/:token.ics
router.get('/feed/:token', getCalendarFeed);

export default router;
