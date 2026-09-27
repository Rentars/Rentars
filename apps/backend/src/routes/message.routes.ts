import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import { messageRateLimiter } from '../middleware/rateLimiter.js';
import { validateBody } from '../validators/booking.validator.js';
import { sendMessageSchema } from '../validators/message.validator.js';
import {
  sendMessageHandler,
  getConversationHandler,
  getConversationByIdHandler,
  markReadHandler,
  retryMessageHandler,
  authorizeAttachmentHandler,
} from '../controllers/message.controller.js';

const router = Router();

// POST /api/v1/messages — send a property / conversation message
router.post('/', authenticate, messageRateLimiter, validateBody(sendMessageSchema), sendMessageHandler);

// GET /api/v1/messages/conversation/:conversationId — membership-gated thread
router.get('/conversation/:conversationId', authenticate, getConversationByIdHandler);

// POST /api/v1/messages/conversation/:conversationId/attachments/authorize
router.post(
  '/conversation/:conversationId/attachments/authorize',
  authenticate,
  authorizeAttachmentHandler,
);

// GET /api/v1/messages/:otherUserId?propertyId=... — legacy property thread
router.get('/:otherUserId', authenticate, getConversationHandler);

// PATCH /api/v1/messages/:id/read — mark a message read (recipient only)
router.patch('/:id/read', authenticate, markReadHandler);

// POST /api/v1/messages/:id/retry — retry failed delivery (sender only)
router.post('/:id/retry', authenticate, messageRateLimiter, retryMessageHandler);

export default router;
