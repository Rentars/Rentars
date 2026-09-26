/**
 * Review Eligibility Service
 *
 * Handles two concerns:
 *
 * 1. Snapshotting eligibility — called by the booking service the moment
 *    a booking transitions to Completed.  Captures all facts that determine
 *    whether each participant may review the other and stores them
 *    immutably in `review_eligibility_snapshots`.
 *
 * 2. Validating a submission — called by the review service before inserting
 *    a review row.  Consults the snapshot and applies the window check so that
 *    the authoritative eligibility record is always the snapshot, not a
 *    re-evaluation of live booking state.
 *
 * Eligible perspectives:
 *   - Tenant reviews the Host (and the property)
 *   - Host reviews the Tenant
 *
 * Ineligibility rules (any one disqualifies the respective side):
 *   - Booking was fully refunded (tenant side only — dispute resolved in favour
 *     of the tenant as if the stay never happened).
 *   - Reviewer is the same user as the target (DB constraint also enforces this).
 *   - The review window has closed (> review_window_days after effective checkout).
 *   - A review from this (booking_id, reviewer_id) pair already exists.
 *
 * Disputed + resolved bookings are handled as follows:
 *   - A booking that was Disputed but then resolved to Completed is eligible
 *     UNLESS a full refund was issued (which sets full_refund_issued = true).
 *   - This allows the non-refunded party (usually the host) to still review.
 *
 * Modified bookings are fully eligible — modifications merely set was_modified
 *   on the snapshot for auditability; they do not restrict reviews.
 */

import { supabase } from '../config/supabase.js';
import type { ServiceResponse } from './index.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ReviewEligibilitySnapshot {
  id: string;
  booking_id: string;
  tenant_id: string;
  host_id: string;
  property_id: string;
  had_dispute: boolean;
  full_refund_issued: boolean;
  was_modified: boolean;
  effective_check_out: string;
  review_window_days: number;
  review_deadline: string;
  tenant_eligible: boolean;
  host_eligible: boolean;
  tenant_ineligible_reason: string | null;
  host_ineligible_reason: string | null;
  prior_status: string;
  created_at: string;
}

export interface EligibilityVerdict {
  eligible: boolean;
  reason: string | null;
  /** The snapshot that was consulted, for support transparency. */
  snapshot: ReviewEligibilitySnapshot;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Default review window in days after effective checkout.
 * Can be extended per-property in the future by storing a per-property
 * review_window_days config; for now a single platform constant is used.
 */
const DEFAULT_REVIEW_WINDOW_DAYS = 14;

// ─── Snapshot creation ────────────────────────────────────────────────────────

interface SnapshotInput {
  bookingId: string;
  tenantId: string;
  hostId: string;
  propertyId: string;
  /** The booking status just before the Completed transition. */
  priorStatus: string;
  /** Effective checkout date (ISO date string, e.g. '2026-09-01').
   *  Use the modification's new end date if the booking was modified. */
  effectiveCheckOut: string;
  /** True when the booking passed through Disputed at any point. */
  hadDispute: boolean;
  /** True when a full refund was issued (cancellation or dispute resolution). */
  fullRefundIssued: boolean;
  /** True when the booking was modified at least once before completion. */
  wasModified: boolean;
}

/**
 * Write an eligibility snapshot atomically when a booking completes.
 *
 * Idempotent — if a snapshot already exists for this booking (e.g. the
 * function is called twice due to a retry) the existing row is returned
 * unchanged via the ON CONFLICT DO NOTHING path.
 */
export async function snapshotEligibility(
  input: SnapshotInput,
): Promise<ServiceResponse<ReviewEligibilitySnapshot>> {
  const {
    bookingId,
    tenantId,
    hostId,
    propertyId,
    priorStatus,
    effectiveCheckOut,
    hadDispute,
    fullRefundIssued,
    wasModified,
  } = input;

  // Compute deadline
  const checkOutDate = new Date(effectiveCheckOut);
  const deadline = new Date(checkOutDate);
  deadline.setDate(deadline.getDate() + DEFAULT_REVIEW_WINDOW_DAYS);
  const reviewDeadline = deadline.toISOString();

  // Determine eligibility for each side
  let tenantEligible = true;
  let tenantIneligibleReason: string | null = null;
  let hostEligible = true;
  let hostIneligibleReason: string | null = null;

  if (fullRefundIssued) {
    // Full refund means the stay effectively did not happen from the
    // tenant's perspective — they should not be able to review the host.
    tenantEligible = false;
    tenantIneligibleReason =
      'A full refund was issued for this booking. Reviews are not permitted ' +
      'when a booking results in a complete refund.';
    // The host cannot review the tenant either, as the stay did not occur.
    hostEligible = false;
    hostIneligibleReason =
      'A full refund was issued for this booking. Reviews are not permitted.';
  }

  // Attempt INSERT; silently ignore duplicate (idempotency).
  const { data, error } = await supabase
    .from('review_eligibility_snapshots')
    .upsert(
      {
        booking_id: bookingId,
        tenant_id: tenantId,
        host_id: hostId,
        property_id: propertyId,
        prior_status: priorStatus,
        had_dispute: hadDispute,
        full_refund_issued: fullRefundIssued,
        was_modified: wasModified,
        effective_check_out: effectiveCheckOut,
        review_window_days: DEFAULT_REVIEW_WINDOW_DAYS,
        review_deadline: reviewDeadline,
        tenant_eligible: tenantEligible,
        host_eligible: hostEligible,
        tenant_ineligible_reason: tenantIneligibleReason,
        host_ineligible_reason: hostIneligibleReason,
      },
      { onConflict: 'booking_id', ignoreDuplicates: true },
    )
    .select()
    .single();

  if (error) {
    // If row exists the upsert with ignoreDuplicates returns no row — fetch it.
    if (error.code === 'PGRST116') {
      return fetchSnapshot(bookingId);
    }
    return { success: false, error: error.message };
  }

  return { success: true, data: data as ReviewEligibilitySnapshot };
}

// ─── Snapshot fetch ───────────────────────────────────────────────────────────

export async function fetchSnapshot(
  bookingId: string,
): Promise<ServiceResponse<ReviewEligibilitySnapshot>> {
  const { data, error } = await supabase
    .from('review_eligibility_snapshots')
    .select('*')
    .eq('booking_id', bookingId)
    .maybeSingle();

  if (error) return { success: false, error: error.message };
  if (!data) return { success: false, error: 'No eligibility snapshot found for this booking' };
  return { success: true, data: data as ReviewEligibilitySnapshot };
}

// ─── Eligibility check ────────────────────────────────────────────────────────

/**
 * Verify whether a given user may submit a review for a given booking.
 *
 * This is the authoritative gate before inserting a review row.
 *
 * Steps:
 *  1. Load the eligibility snapshot for the booking.
 *  2. Determine whether the reviewer is the tenant or the host.
 *  3. Apply the snapshotted eligibility verdict.
 *  4. Check the review window (time-sensitive, evaluated at submission time).
 *  5. Check for a pre-existing review from this reviewer on this booking.
 *
 * @param bookingId  - The booking being reviewed.
 * @param reviewerId - The user attempting to submit the review.
 * @param targetId   - The user being reviewed.
 */
export async function checkReviewEligibility(
  bookingId: string,
  reviewerId: string,
  targetId: string,
): Promise<ServiceResponse<EligibilityVerdict>> {
  // Self-review guard (belt-and-suspenders; DB constraint also enforces this).
  if (reviewerId === targetId) {
    return { success: false, error: 'You cannot review yourself' };
  }

  // 1. Load snapshot
  const snapshotResult = await fetchSnapshot(bookingId);
  if (!snapshotResult.success || !snapshotResult.data) {
    return {
      success: false,
      error:
        snapshotResult.error ??
        'This booking has no eligibility record. Only completed bookings can be reviewed.',
    };
  }
  const snap = snapshotResult.data;

  // 2. Determine perspective
  const isTenant = snap.tenant_id === reviewerId;
  const isHost   = snap.host_id   === reviewerId;

  if (!isTenant && !isHost) {
    return {
      success: false,
      error: 'Only the tenant or host of this booking may submit a review.',
    };
  }

  // Verify target matches the other participant
  if (isTenant && targetId !== snap.host_id) {
    return {
      success: false,
      error: 'As the tenant, you can only review the host of this booking.',
    };
  }
  if (isHost && targetId !== snap.tenant_id) {
    return {
      success: false,
      error: 'As the host, you can only review the tenant of this booking.',
    };
  }

  // 3. Snapshotted eligibility verdict
  const snapshotEligible = isTenant ? snap.tenant_eligible : snap.host_eligible;
  const snapshotReason   = isTenant ? snap.tenant_ineligible_reason : snap.host_ineligible_reason;

  if (!snapshotEligible) {
    return {
      success: false,
      error: snapshotReason ?? 'You are not eligible to review this booking.',
    };
  }

  // 4. Review window check (live — evaluated at submission time)
  const now      = new Date();
  const deadline = new Date(snap.review_deadline);
  if (now > deadline) {
    return {
      success: false,
      error: `The review window for this booking closed on ${deadline.toISOString().slice(0, 10)}. Reviews must be submitted within ${snap.review_window_days} days of checkout.`,
    };
  }

  // 5. Duplicate check — one review per (booking_id, reviewer_id)
  const { data: existing, error: dupError } = await supabase
    .from('reviews')
    .select('id')
    .eq('booking_id', bookingId)
    .eq('reviewer_id', reviewerId)
    .maybeSingle();

  if (dupError) return { success: false, error: dupError.message };
  if (existing) {
    return {
      success: false,
      error: 'You have already submitted a review for this booking.',
    };
  }

  return {
    success: true,
    data: {
      eligible: true,
      reason: null,
      snapshot: snap,
    },
  };
}

// ─── Support / admin helpers ──────────────────────────────────────────────────

/**
 * Return the eligibility snapshot for a booking so support can explain
 * eligibility decisions without re-evaluating live booking state.
 */
export async function getEligibilityExplanation(
  bookingId: string,
): Promise<ServiceResponse<ReviewEligibilitySnapshot & { explanation: string }>> {
  const result = await fetchSnapshot(bookingId);
  if (!result.success || !result.data) {
    return { success: false, error: result.error };
  }

  const snap = result.data;
  const deadline = new Date(snap.review_deadline);
  const now = new Date();
  const windowOpen = now <= deadline;

  const lines: string[] = [
    `Booking: ${snap.booking_id}`,
    `Completed from status: ${snap.prior_status}`,
    `Effective checkout: ${snap.effective_check_out}`,
    `Review window: ${snap.review_window_days} days (deadline: ${deadline.toISOString().slice(0, 10)})`,
    `Window currently: ${windowOpen ? 'OPEN' : 'CLOSED'}`,
    `Had dispute: ${snap.had_dispute}`,
    `Full refund issued: ${snap.full_refund_issued}`,
    `Was modified: ${snap.was_modified}`,
    `Tenant eligible: ${snap.tenant_eligible}${snap.tenant_ineligible_reason ? ` — ${snap.tenant_ineligible_reason}` : ''}`,
    `Host eligible:   ${snap.host_eligible}${snap.host_ineligible_reason ? ` — ${snap.host_ineligible_reason}` : ''}`,
  ];

  return {
    success: true,
    data: {
      ...snap,
      explanation: lines.join('\n'),
    },
  };
}
