import type { Response } from 'express';
import type { AuthRequest } from '../middleware/auth.middleware.js';
import {
  sendMessageWithParams,
  getConversation,
  getConversationById,
  markMessageRead,
  retryMessageDelivery,
  assertCanAttach,
  messageDeliveryMetrics,
} from '../services/message.service.js';

function statusForMessageError(error: string | undefined): number {
  if (!error) return 400;
  if (error.includes('not found') || error.includes('not found')) return 404;
  if (error.startsWith('Forbidden') || error.includes('deleted')) return 403;
  if (error.includes('not allowed') || error.includes('archived')) return 409;
  return 400;
}

export async function sendMessageHandler(req: AuthRequest, res: Response): Promise<void> {
  const senderId = req.userId;
  if (!senderId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { propertyId, body, recipientId, conversationId, bookingId, clientMessageId } = req.body;
  const result = await sendMessageWithParams({
    senderId,
    propertyId,
    body,
    recipientId,
    conversationId,
    bookingId,
    clientMessageId,
  });

  if (!result.success) {
    res.status(statusForMessageError(result.error)).json({ error: result.error });
    return;
  }

  res.status(201).json(result.data);
}

export async function getConversationHandler(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { otherUserId } = req.params;
  const propertyId = req.query.propertyId as string | undefined;
  if (!propertyId) {
    res.status(400).json({ error: 'propertyId query parameter is required' });
    return;
  }

  const result = await getConversation(userId, otherUserId, propertyId);

  if (!result.success) {
    res.status(statusForMessageError(result.error)).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

export async function getConversationByIdHandler(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const result = await getConversationById(userId, req.params.conversationId);

  if (!result.success) {
    res.status(statusForMessageError(result.error)).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

export async function markReadHandler(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const result = await markMessageRead(req.params.id, userId);

  if (!result.success) {
    res.status(statusForMessageError(result.error)).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

export async function retryMessageHandler(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const result = await retryMessageDelivery(req.params.id, userId);

  if (!result.success) {
    res.status(statusForMessageError(result.error)).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

/**
 * Pre-flight authorization for attachment uploads — membership only.
 * Actual file handling remains in the upload pipeline.
 */
export async function authorizeAttachmentHandler(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const result = await assertCanAttach(req.params.conversationId, userId);
  if (!result.success) {
    res.status(statusForMessageError(result.error)).json({ error: result.error });
    return;
  }

  res.json({ allowed: true, conversationId: result.data!.id });
}

export async function messageMetricsHandler(_req: AuthRequest, res: Response): Promise<void> {
  res.json({ delivery: { ...messageDeliveryMetrics } });
}
