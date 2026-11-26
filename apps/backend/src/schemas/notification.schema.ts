/**
 * Canonical Zod schemas for Notification API shapes.
 *
 * Keep in sync with openapi.json #/components/schemas/Notification*.
 */

import { z } from 'zod';

// ── Enums ─────────────────────────────────────────────────────────────────────

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

// ── Single notification ───────────────────────────────────────────────────────

export const NotificationSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  type: NotificationTypeSchema,
  data: z.record(z.unknown()).optional(),
  read: z.boolean(),
  created_at: z.string().datetime(),
});

// ── List response envelope ────────────────────────────────────────────────────

export const NotificationListResponseSchema = z.object({
  data: z.array(NotificationSchema),
  unread_count: z.number().int().min(0).optional(),
  cursor: z.string().nullable().optional(),
});

// ── Type exports ──────────────────────────────────────────────────────────────

export type NotificationType = z.infer<typeof NotificationTypeSchema>;
export type Notification = z.infer<typeof NotificationSchema>;
export type NotificationListResponse = z.infer<typeof NotificationListResponseSchema>;
