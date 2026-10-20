// ─── Booking status ───────────────────────────────────────────────────────────

/**
 * All valid booking status values.
 *
 * DB stores title-case (Pending, Confirmed, …) but the frontend normalises
 * everything to lowercase for comparisons so both forms are included.
 */
export type BookingStatus =
  | 'Pending'   | 'pending'
  | 'Confirmed' | 'confirmed'
  | 'Completed' | 'completed'
  | 'Cancelled' | 'cancelled'
  | 'Disputed'  | 'disputed';

/** Normalise a raw status string from the API to lowercase. */
export function normaliseStatus(status: string): Lowercase<BookingStatus> {
  return status.toLowerCase() as Lowercase<BookingStatus>;
}

// ─── Allowed lifecycle transitions ───────────────────────────────────────────

/**
 * Valid transitions the current user (tenant) may trigger from each state.
 * Mirrors the server-side state machine.
 */
export const TENANT_TRANSITIONS: Record<string, ('confirm' | 'complete' | 'cancel' | 'dispute')[]> = {
  pending:   ['cancel'],
  confirmed: ['complete', 'dispute', 'cancel'],
  completed: [],
  cancelled: [],
  disputed:  [],
};

// ─── Core types ───────────────────────────────────────────────────────────────

/**
 * Lifecycle of a refund request.
 *
 * A refund is only ever described as complete when it reaches `confirmed`;
 * `requested`, `submitted`, `failed`, and `manual_review` must never be
 * presented to users as a finished refund.
 */
export type RefundState =
  | 'requested'
  | 'submitted'
  | 'confirmed'
  | 'failed'
  | 'manual_review';

/** Server-computed refund breakdown shown to the user before cancelling. */
export interface RefundCalculation {
  /** Policy tier applied (e.g. 'flexible', 'moderate', 'strict'). */
  tier: string;
  /** Percentage of the eligible value refunded (0–100). */
  refundPct: number;
  /** Refund amount in integer minor units of `currency`. */
  refundAmountMinor: number;
  /** ISO 4217 currency code (or canonical token unit). */
  currency: string;
}

export interface Booking {
  id: string;
  property_id: string;
  tenant_id: string;
  check_in: string;
  check_out: string;
  guest_count: number;
  total_price: number;
  status: BookingStatus;
  escrow_id?: string;
  escrow_status?: 'locked' | 'released' | 'refunded';
  on_chain_id?: number;
  rules_acknowledged_at?: string | null;
  dispute_reason?: string | null;
  created_at: string;
  updated_at?: string;
  /** Version of the quote the payment authorization is bound to. */
  quote_version?: number;
  /** Authorized amount in integer minor units of `quote_currency`. */
  quote_amount_minor?: number;
  /** Canonical currency code for the quote. */
  quote_currency?: string;
  /** Whether the settled on-chain amount matched the quote exactly. */
  settlement_verified?: boolean;
  /** Reconciliation outcome for the settled payment. */
  reconciliation_state?: 'pending' | 'matched' | 'mismatch' | 'manual_review';
  /** Current state of the refund request, if any. */
  refund_request_state?: RefundState;
  /** Booking-time refund calculation snapshot. */
  refund_calculation?: RefundCalculation;
}

export interface BookingFormData {
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  propertyId: string;
}

export interface BookingWithProperty extends Booking {
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
