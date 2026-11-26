import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import { messageRateLimiter } from '../middleware/rateLimiter.js';
import { validateBody } from '../validators/booking.validator.js';
import { sendMessageSchema } from '../validators/message.validator.js';
import {
  sendMessageHandler,
  getConversationHandler,
  markReadHandler,
} from '../controllers/message.controller.js';

const router = Router();

// POST /api/v1/messages — send a property inquiry message
// Messaging has its own dedicated budget, keyed by authenticated user ID.
router.post('/', authenticate, messageRateLimiter, validateBody(sendMessageSchema), sendMessageHandler);

// GET /api/v1/messages/:otherUserId?propertyId=... — list a conversation
router.get('/:otherUserId', authenticate, getConversationHandler);

// PATCH /api/v1/messages/:id/read — mark a message read
router.patch('/:id/read', authenticate, markReadHandler);

export default router;