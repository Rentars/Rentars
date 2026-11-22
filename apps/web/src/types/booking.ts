/**
 * Booking types — re-exported from the canonical Zod schema.
 *
 * The Zod schema at @/lib/api-schemas/booking.schema is the single source of
 * truth.  Import directly from there to access the schema validators. This
 * file re-exports the inferred TypeScript types for backwards compatibility
 * with existing code that imports from @/types/booking.
 */

export type {
  BookingStatus,
  EscrowStatus,
  BookingDetail as Booking,
  BookingListResponse,
  CreateBookingRequest as BookingFormData,
} from '@/lib/api-schemas/booking.schema';

export {
  BookingStatusSchema,
  EscrowStatusSchema,
  BookingDetailSchema,
  BookingListResponseSchema,
} from '@/lib/api-schemas/booking.schema';

// ── Utility helpers (not part of the schema) ──────────────────────────────────

/** Normalise a raw status string from the API to lowercase. */
export function normaliseStatus(status: string): string {
  return status.toLowerCase();
}

/**
 * Valid transitions the current user (tenant) may trigger from each state.
 * Mirrors the server-side state machine.
 */
export const TENANT_TRANSITIONS: Record<
  string,
  ('confirm' | 'complete' | 'cancel' | 'dispute')[]
> = {
  pending: ['cancel'],
  confirmed: ['complete', 'dispute', 'cancel'],
  completed: [],
  cancelled: [],
  disputed: [],
};

// ── Augmented type for pages that need the nested property ────────────────────

import type { BookingDetail } from '@/lib/api-schemas/booking.schema';

export interface BookingWithProperty extends BookingDetail {
  property?: {
    id: string;
    title: string;
    city?: string;
    country?: string;
    address?: string;
    images?: string[];
    slug?: string;
    owner_id?: string;
  };
}
