/**
 * Canonical Zod schemas for Payment API shapes.
 *
 * Keep in sync with openapi.json #/components/schemas/Payment*.
 */

import { z } from 'zod';

// ── Enums ─────────────────────────────────────────────────────────────────────

export const PaymentStatusValueSchema = z.enum([
  'pending',
  'submitted',
  'confirmed',
  'failed',
  'timeout',
  'expired',
]);

// ── Payment status response (GET /payments/:id/status) ───────────────────────

export const PaymentStatusResponseSchema = z.object({
  bookingId: z.string().uuid(),
  status: PaymentStatusValueSchema,
  txHash: z.string().nullable().optional(),
  escrowId: z.string().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  updatedAt: z.string().datetime(),
});

// ── Payment submit request ────────────────────────────────────────────────────

export const PaymentSubmitRequestSchema = z.object({
  bookingId: z.string().uuid(),
  xdr: z.string().min(1),
});

// ── Type exports ──────────────────────────────────────────────────────────────

export type PaymentStatusValue = z.infer<typeof PaymentStatusValueSchema>;
export type PaymentStatusResponse = z.infer<typeof PaymentStatusResponseSchema>;
export type PaymentSubmitRequest = z.infer<typeof PaymentSubmitRequestSchema>;
