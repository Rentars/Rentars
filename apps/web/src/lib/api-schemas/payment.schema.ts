/**
 * Frontend mirror of apps/backend/src/schemas/payment.schema.ts
 */

import { z } from 'zod';

export const PaymentStatusValueSchema = z.enum([
  'pending',
  'submitted',
  'confirmed',
  'failed',
  'timeout',
  'expired',
]);

export const PaymentStatusResponseSchema = z.object({
  bookingId: z.string().uuid(),
  status: PaymentStatusValueSchema,
  txHash: z.string().nullable().optional(),
  escrowId: z.string().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  updatedAt: z.string().datetime(),
});

export const PaymentSubmitRequestSchema = z.object({
  bookingId: z.string().uuid(),
  xdr: z.string().min(1),
});

export type PaymentStatusValue = z.infer<typeof PaymentStatusValueSchema>;
export type PaymentStatusResponse = z.infer<typeof PaymentStatusResponseSchema>;
export type PaymentSubmitRequest = z.infer<typeof PaymentSubmitRequestSchema>;
