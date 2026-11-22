/**
 * Frontend mirror of apps/backend/src/schemas/notification.schema.ts
 */

import { z } from 'zod';

export const NotificationTypeSchema = z.enum([
  'booking_created',
  'booking_confirmed',
  'booking_cancelled',
  'booking_completed',
  'booking_disputed',
  'payment_received',
  'payment_failed',
  'review_received',
  'review_response',
  'system',
]);

export const NotificationSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  type: NotificationTypeSchema,
  data: z.record(z.unknown()).optional(),
  read: z.boolean(),
  created_at: z.string().datetime(),
});

export const NotificationListResponseSchema = z.object({
  data: z.array(NotificationSchema),
  unread_count: z.number().int().min(0).optional(),
  cursor: z.string().nullable().optional(),
});

export type NotificationType = z.infer<typeof NotificationTypeSchema>;
export type Notification = z.infer<typeof NotificationSchema>;
export type NotificationListResponse = z.infer<typeof NotificationListResponseSchema>;
