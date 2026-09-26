import { supabase } from '../config/supabase.js';
import * as cache from './cache.service.js';
import type { ServiceResponse } from './index.js';
import { sanitizeLongText, sanitizeResponse } from '../utils/sanitize.js';
import type { PaginatedResult } from '../types/pagination.js';
import { executePaginatedQuery } from '../utils/pagination.js';
import { checkReviewEligibility } from './reviewEligibility.service.js';

export type ModerationStatus = 'pending' | 'approved' | 'rejected';

export interface Review {
  id: string;
  booking_id: string;
  reviewer_id: string;
  target_id: string;
  property_id?: string;
  rating: number;
  comment?: string;
  on_chain_id?: number;
  host_response?: string;
  host_response_at?: string;
  is_flagged?: boolean;
  flag_reason?: string;
  is_approved?: boolean;
  moderation_status?: ModerationStatus;
  moderation_reason?: string;
  created_at?: string;
}

/**
 * Submit a review from either the tenant (reviewing the host/property) or
 * the host (reviewing the tenant).
 *
 * Eligibility is validated against the immutable `review_eligibility_snapshot`
 * that was written when the booking completed.  This keeps eligibility
 * decisions explainable even if booking or modification records change later.
 *
 * Both perspectives are supported:
 *   - Tenant  → reviews the host (propertyId should be provided)
 *   - Host    → reviews the tenant (propertyId is ignored / null)
 */
export async function submitReview(
  bookingId: string,
  reviewerId: string,
  targetId: string,
  rating: number,
  comment: string,
  propertyId?: string,
): Promise<ServiceResponse<Review>> {
  if (rating < 1 || rating > 5) {
    return { success: false, error: 'Rating must be between 1 and 5' };
  }

  // Sanitize user-supplied text; enforce max 2000 chars for review comments.
  // Trim happens inside sanitizeLongText, so validate length on the cleaned
  // value — a whitespace-only comment must be rejected here, not stored as
  // an empty string after the DB round-trip.
  const cleanComment = sanitizeLongText(comment, 2_000);
  if (cleanComment.length === 0) {
    return { success: false, error: 'Comment is required' };
  }

  // ── Eligibility gate ──────────────────────────────────────────────────────
  // Consults the immutable eligibility snapshot written at booking completion.
  // This is the authoritative check — no re-evaluation of live booking state.
  const eligibilityResult = await checkReviewEligibility(bookingId, reviewerId, targetId);
  if (!eligibilityResult.success) {
    return { success: false, error: eligibilityResult.error };
  }

  // Resolve propertyId from snapshot when the reviewer is the tenant so
  // hosts submitting tenant-reviews are not required to pass propertyId.
  const snap = eligibilityResult.data!.snapshot;
  const resolvedPropertyId =
    propertyId ??
    (snap.tenant_id === reviewerId ? snap.property_id : undefined);

  // ── Insert review ─────────────────────────────────────────────────────────
  const { data, error } = await supabase
    .from('reviews')
    .insert({
      booking_id: bookingId,
      reviewer_id: reviewerId,
      target_id: targetId,
      property_id: resolvedPropertyId ?? null,
      rating,
      comment: cleanComment,
    })
    .select()
    .single();

  if (error) {
    // Unique constraint violation — race-condition duplicate submission
    if (error.code === '23505') {
      return { success: false, error: 'You have already submitted a review for this booking.' };
    }
    return { success: false, error: error.message };
  }

  // Invalidate the property detail cache so the updated rating aggregate is reflected.
  if (resolvedPropertyId) {
    await cache.del(`property:${resolvedPropertyId}`);
  }

  // Notify the target that a new review was submitted
  try {
    const { createNotification } = await import('./notification.service.js');
    const isTenantReview = snap.tenant_id === reviewerId;
    await createNotification(targetId, 'review_submitted', {
      reviewId: (data as Review).id,
      reviewerId,
      propertyId: resolvedPropertyId ?? null,
      rating,
      perspective: isTenantReview ? 'tenant_reviewed_host' : 'host_reviewed_tenant',
      message: isTenantReview
        ? `A guest left you a ${rating}-star review.`
        : `The host left you a ${rating}-star review.`,
    });
  } catch {
    // Notification failure must never block the review submission
  }

  // ── Trust risk: review pattern signal ─────────────────────────────────────
  // Run a full signal pass for the reviewer fire-and-forget.
  // Catches suspicious patterns (volume in 24 h, all-1-star bursts).
  runReviewerRiskEval(reviewerId, (data as Review).id).catch(() => {});

  return { success: true, data: data as Review };
}

/**
 * Evaluate trust risk signals for a reviewer after they submit a review.
 * Non-fatal — called fire-and-forget.
 */
async function runReviewerRiskEval(reviewerId: string, reviewId: string): Promise<void> {
  try {
    const { runRiskEvaluation } = await import('./trustRisk.service.js');
    const result = await runRiskEvaluation(reviewerId);
    if (result.success && result.data) {
      // Enqueue a mandatory trust_case_action notification so the user is
      // informed of the automated action through their preferred channel.
      const { enqueue } = await import('./notificationOutbox.service.js');
      await enqueue({
        userId:         reviewerId,
        type:           'trust_case_action',
        idempotencyKey: `trust_case_action:${result.data.id}:${reviewerId}`,
        channels:       ['in_app', 'email'],
        sourceEvent:    'review_submitted',
        sourceId:       reviewId,
        data: {
          caseId:    result.data.id,
          riskLevel: result.data.risk_level,
          action:    result.data.automated_action,
          message:   `Your account is under review. Our trust team will be in touch if any action is required.`,
        },
      });
    }
  } catch {
    // Signal evaluation must never surface errors to the review submission caller
  }
}

export async function getReviewsForProperty(propertyId: string, page = 1, pageSize = 20): Promise<ServiceResponse<PaginatedResult<Review>>> {
  const query = supabase
    .from('reviews')
    .select('*', { count: 'exact' })
    .eq('property_id', propertyId)
    .eq('moderation_status', 'approved')
    .order('created_at', { ascending: false });

  const response = await executePaginatedQuery(query, page, pageSize);
  if (response.error) return { success: false, error: response.error };
  return { success: true, data: response.result };
}

export async function getReviewsForUser(userId: string, page = 1, pageSize = 20): Promise<ServiceResponse<PaginatedResult<Review>>> {
  const query = supabase
    .from('reviews')
    .select('*', { count: 'exact' })
    .eq('target_id', userId)
    .eq('moderation_status', 'approved')
    .order('created_at', { ascending: false });

  const response = await executePaginatedQuery(query, page, pageSize);
  if (response.error) return { success: false, error: response.error };
  return { success: true, data: response.result };
}

export async function getAverageRating(userId: string): Promise<ServiceResponse<number>> {
  const { data, error } = await supabase
    .from('reviews')
    .select('rating')
    .eq('target_id', userId)
    .eq('is_approved', true);

  if (error) return { success: false, error: error.message };
  // Return zero for both null responses and empty arrays so callers always
  // receive a valid numeric zero rather than NaN for unrated properties.
  if (!data || data.length === 0) return { success: true, data: 0 };

  const rows = data as { rating: number }[];
  const avg = rows.reduce((sum, r) => sum + r.rating, 0) / rows.length;
  return { success: true, data: Math.round(avg * 10) / 10 };
}

const MAX_HOST_RESPONSE_LENGTH = 1000;

export async function addHostResponse(
  reviewId: string,
  hostId: string,
  response: string,
): Promise<ServiceResponse<Review>> {
  if (response.trim().length > MAX_HOST_RESPONSE_LENGTH) {
    return {
      success: false,
      error: `Response must be at most ${MAX_HOST_RESPONSE_LENGTH} characters`,
    };
  }

  const { data: review, error: reviewError } = await supabase
    .from('reviews')
    .select('id, target_id, property_id, host_response')
    .eq('id', reviewId)
    .single();

  if (reviewError || !review) {
    return { success: false, error: 'Review not found' };
  }

  const r = review as {
    id: string;
    target_id: string;
    property_id: string | null;
    host_response: string | null;
  };

  if (r.host_response) {
    return { success: false, error: 'This review already has a host response' };
  }

  // Verify host owns the reviewed property; fall back to target_id check when no property
  if (r.property_id) {
    const { data: property } = await supabase
      .from('properties')
      .select('owner_id')
      .eq('id', r.property_id)
      .single();

    if (!property || (property as { owner_id: string }).owner_id !== hostId) {
      return { success: false, error: 'Only the property owner can respond to this review' };
    }
  } else if (r.target_id !== hostId) {
    return { success: false, error: 'Only the reviewed host can respond' };
  }

  // Sanitize host response; enforce max 2000 chars
  const cleanResponse = sanitizeResponse(response, 2_000);
  if (!cleanResponse) {
    return { success: false, error: 'Response text is required' };
  }

  const { data, error } = await supabase
    .from('reviews')
    .update({ host_response: cleanResponse, host_response_at: new Date().toISOString() })
    .eq('id', reviewId)
    .is('host_response', null)
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  if (!data) {
    return { success: false, error: 'This review already has a host response' };
  }

  // Notify the reviewer that the host has responded
  try {
    const updatedReview = data as Review;
    const { createNotification } = await import('./notification.service.js');
    await createNotification(updatedReview.reviewer_id, 'host_response', {
      reviewId,
      hostId,
      propertyId: updatedReview.property_id ?? null,
      message: 'The host responded to your review.',
    });
  } catch {
    // Notification failure must never block the host response submission
  }

  return { success: true, data: data as Review };
}

export async function flagReview(
  reviewId: string,
  reporterId: string,
  reason: string,
): Promise<ServiceResponse<void>> {
  const trimmedReason = reason?.trim();
  if (!trimmedReason) {
    return { success: false, error: 'Flag reason is required' };
  }

  const { error } = await supabase
    .from('reviews')
    .update({ is_flagged: true, flag_reason: trimmedReason })
    .eq('id', reviewId);

  if (error) return { success: false, error: error.message };
  return { success: true };
}

export async function approveReview(
  reviewId: string,
  actorId?: string,
): Promise<ServiceResponse<Review>> {
  const { data, error } = await supabase
    .from('reviews')
    .update({ moderation_status: 'approved', is_approved: true, is_flagged: false })
    .eq('id', reviewId)
    .select()
    .single();

  if (error) return { success: false, error: error.message };

  if (actorId) {
    const { record } = await import('./auditLog.service.js');
    await record(actorId, 'review.approve', 'review', reviewId);
  }

  return { success: true, data: data as Review };
}

export async function rejectReview(
  reviewId: string,
  reason: string,
  actorId?: string,
): Promise<ServiceResponse<Review>> {
  if (!reason || reason.trim().length === 0) {
    return { success: false, error: 'Rejection reason is required' };
  }

  const { data, error } = await supabase
    .from('reviews')
    .update({ moderation_status: 'rejected', is_approved: false, moderation_reason: reason, is_flagged: false })
    .eq('id', reviewId)
    .select()
    .single();

  if (error) return { success: false, error: error.message };

  if (actorId) {
    const { record } = await import('./auditLog.service.js');
    await record(actorId, 'review.reject', 'review', reviewId, { reason });
  }

  return { success: true, data: data as Review };
}

export async function getPendingReviews(): Promise<ServiceResponse<Review[]>> {
  const { data, error } = await supabase
    .from('reviews')
    .select('*')
    .eq('moderation_status', 'pending')
    .order('created_at', { ascending: true });

  if (error) return { success: false, error: error.message };
  return { success: true, data: (data ?? []) as Review[] };
}

export async function moderateReview(
  reviewId: string,
  approve: boolean,
  actorId?: string,
): Promise<ServiceResponse<Review>> {
  return approve
    ? approveReview(reviewId, actorId)
    : rejectReview(reviewId, 'Rejected by moderator', actorId);
}

export async function getFlaggedReviews(): Promise<ServiceResponse<Review[]>> {
  const { data, error } = await supabase
    .from('reviews')
    .select('*')
    .eq('is_flagged', true)
    .order('created_at', { ascending: false });

  if (error) return { success: false, error: error.message };
  return { success: true, data: (data ?? []) as Review[] };
}
