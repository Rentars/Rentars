import { z } from 'zod';

export const sendMessageSchema = z.object({
  propertyId: z
    .string({ required_error: 'propertyId is required' })
    .uuid('propertyId must be a valid UUID'),
  body: z
    .string({ required_error: 'body is required' })
    .min(1, 'body must not be empty')
    .max(2000, 'body must be at most 2000 characters'),
  recipientId: z.string().uuid('recipientId must be a valid UUID').optional(),
  conversationId: z.string().uuid('conversationId must be a valid UUID').optional(),
  bookingId: z.string().uuid('bookingId must be a valid UUID').optional(),
  /** Stable client identity across retries and devices (#640). */
  clientMessageId: z
    .string()
    .min(1)
    .max(128)
    .optional(),
});
