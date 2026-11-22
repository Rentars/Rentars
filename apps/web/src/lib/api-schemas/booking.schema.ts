/**
 * Frontend mirror of apps/backend/src/schemas/booking.schema.ts
 */

import { z } from 'zod';

export const BookingStatusSchema = z.enum([
  'pending',
  'confirmed',
  'completed',
  'cancelled',
  'disputed',
]);

export const EscrowStatusSchema = z.enum([
  'locked',
  'released',
  'refunded',
  'pending',
  'manual_review',
]);

export const BookingDetailSchema = z.object({
  id: z.string().uuid(),
  property_id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  check_in: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  check_out: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  guest_count: z.number().int().min(1).optional(),
  total_price: z.number().min(0),
  status: BookingStatusSchema,
  escrow_id: z.string().nullable().optional(),
  escrow_status: EscrowStatusSchema.nullable().optional(),
  on_chain_id: z.number().int().nullable().optional(),
  rules_acknowledged_at: z.string().datetime().nullable().optional(),
  dispute_reason: z.string().nullable().optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime().nullable().optional(),
});

export const BookingListResponseSchema = z.object({
  data: z.array(BookingDetailSchema),
  cursor: z.string().nullable().optional(),
  has_more: z.boolean().optional(),
});

export const CreateBookingRequestSchema = z.object({
  property_id: z.string().uuid(),
  check_in: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  check_out: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  guest_count: z.number().int().min(1).optional(),
  rules_acknowledged: z.boolean().optional(),
});

export type BookingStatus = z.infer<typeof BookingStatusSchema>;
export type EscrowStatus = z.infer<typeof EscrowStatusSchema>;
export type BookingDetail = z.infer<typeof BookingDetailSchema>;
export type BookingListResponse = z.infer<typeof BookingListResponseSchema>;
export type CreateBookingRequest = z.infer<typeof CreateBookingRequestSchema>;
