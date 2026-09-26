/**
 * Trust Risk Signal Service
 *
 * Consumes events that already exist in the platform (reports, chargebacks,
 * failed identity checks, suspicious review patterns, dispute history) and
 * translates them into a scored risk case for human moderation.
 *
 * Design principles:
 *   - No opaque irreversible automation.  Every automated action is stored
 *     with its triggering signals and can be overridden by a moderator.
 *   - Every decision is audited via auditLog.service.ts.
 *   - Normal users are never blocked by a single weak signal.  A case is
 *     only created when the aggregate score breaches CASE_CREATION_THRESHOLD.
 *   - False-positive recovery: moderators can clear a case, lift the action,
 *     and mark it as a false positive.  The user is then notified.
 *
 * ── Signal catalogue ──────────────────────────────────────────────────────────
 *
 * Signal name                     Score  Triggered by
 * ─────────────────────────────── ─────  ─────────────────────────────────────
 * repeated_reports                 15    ≥ 3 reports in 30 days against user
 * chargeback_filed                 40    payment chargeback event
 * failed_identity_check            25    KYC / ID verification failure
 * suspicious_review_pattern        20    ≥ 5 reviews in 24 h, or all 1-star
 * dispute_history_high             20    ≥ 3 disputes as tenant in 90 days
 * dispute_history_medium           10    2 disputes as tenant in 90 days
 * multiple_cancellations           10    ≥ 5 late cancellations in 30 days
 * account_age_very_new              5    account < 48 h old at booking time
 * high_value_first_booking         15    first booking > configured threshold
 *
 * ── Risk levels ───────────────────────────────────────────────────────────────
 *
 * Score   Level     Automated action
 * ─────── ────────  ────────────────────────────────────────────────
 * 0–19    low       none
 * 20–39   medium    account_review  (flag for human review, no restriction)
 * 40–59   high      step_up_verification (prompt user for additional ID)
 * 60+     critical  temporary_hold  (bookings/transactions paused)
 *
 * ── False-positive recovery ───────────────────────────────────────────────────
 *
 * A moderator calls overrideCase(caseId, actorId, action, reason) where action
 * is one of: 'lifted' | 'escalated' | 'cleared'.
 * 'cleared' sets false_positive=true, lifts any action, and closes the case.
 * The user receives a notification that their account has been reviewed and
 * cleared.
 */

import { supabase } from '../config/supabase.js';
import { record as auditRecord } from './auditLog.service.js';
import type { ServiceResponse } from './index.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type AutomatedAction = 'none' | 'step_up_verification' | 'temporary_hold' | 'account_review';
export type CaseStatus = 'open' | 'under_review' | 'resolved' | 'overridden' | 'closed';
export type OverrideAction = 'lifted' | 'escalated' | 'suspended' | 'cleared';

export interface SignalInput {
  /** Canonical signal name from the catalogue above. */
  signal: string;
  /** Numeric score contribution. */
  score: number;
  /** Human-readable explanation for moderators. */
  detail: string;
  /** Source entity type (booking, report, review, payment, identity_check). */
  sourceType?: string;
  /** UUID of the source entity. */
  sourceId?: string;
}

export interface TrustRiskCase {
  id: string;
  user_id: string;
  risk_level: RiskLevel;
  signals: SignalInput[];
  total_score: number;
  automated_action: AutomatedAction;
  action_active: boolean;
  status: CaseStatus;
  assigned_to: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  override_action: OverrideAction | null;
  override_by: string | null;
  override_at: string | null;
  override_reason: string | null;
  false_positive: boolean;
  created_at: string;
  updated_at: string;
}

export interface EvaluateSignalsInput {
  userId: string;
  signals: SignalInput[];
}

// ─── Score thresholds ─────────────────────────────────────────────────────────

/** Minimum aggregate score required before a case is created. */
const CASE_CREATION_THRESHOLD = 20;

const RISK_LEVELS: Array<{ minScore: number; level: RiskLevel; action: AutomatedAction }> = [
  { minScore: 60, level: 'critical', action: 'temporary_hold' },
  { minScore: 40, level: 'high',     action: 'step_up_verification' },
  { minScore: 20, level: 'medium',   action: 'account_review' },
  { minScore: 0,  level: 'low',      action: 'none' },
];

// ─── Score helpers ────────────────────────────────────────────────────────────

function classify(totalScore: number): { level: RiskLevel; action: AutomatedAction } {
  for (const tier of RISK_LEVELS) {
    if (totalScore >= tier.minScore) {
      return { level: tier.level, action: tier.action };
    }
  }
  return { level: 'low', action: 'none' };
}

// ─── Core evaluation ──────────────────────────────────────────────────────────

/**
 * Evaluate a set of signals for a user.
 *
 * If the aggregate score is below CASE_CREATION_THRESHOLD no case is created
 * and the function returns `{ success: true, data: null }` — this is the normal
 * path for most users.
 *
 * If the threshold is breached a case is inserted (or the existing open case
 * is updated) and the appropriate automated action is stored.
 *
 * @returns The case if one was created/updated, or null if below threshold.
 */
export async function evaluateSignals(
  input: EvaluateSignalsInput,
): Promise<ServiceResponse<TrustRiskCase | null>> {
  const { userId, signals } = input;

  if (!signals.length) return { success: true, data: null };

  const totalScore = signals.reduce((sum, s) => sum + s.score, 0);

  if (totalScore < CASE_CREATION_THRESHOLD) {
    return { success: true, data: null };
  }

  const { level, action } = classify(totalScore);

  // Check for an existing open case for this user.
  const { data: existing } = await supabase
    .from('trust_risk_cases')
    .select('id, total_score, signals, risk_level')
    .eq('user_id', userId)
    .eq('status', 'open')
    .maybeSingle();

  let caseId: string;
  let caseData: TrustRiskCase;

  if (existing) {
    // Merge signals and re-classify.
    const prev = existing as { id: string; total_score: number; signals: SignalInput[] };
    const mergedSignals = [...(prev.signals ?? []), ...signals];
    const mergedScore = mergedSignals.reduce((sum, s) => sum + s.score, 0);
    const merged = classify(mergedScore);

    const { data, error } = await supabase
      .from('trust_risk_cases')
      .update({
        signals: mergedSignals,
        total_score: mergedScore,
        risk_level: merged.level,
        automated_action: merged.action,
        action_active: merged.action !== 'none',
      })
      .eq('id', prev.id)
      .select()
      .single();

    if (error) return { success: false, error: error.message };
    caseId   = prev.id;
    caseData = data as TrustRiskCase;
  } else {
    // Create new case.
    const { data, error } = await supabase
      .from('trust_risk_cases')
      .insert({
        user_id:          userId,
        risk_level:       level,
        signals,
        total_score:      totalScore,
        automated_action: action,
        action_active:    action !== 'none',
        status:           'open',
      })
      .select()
      .single();

    if (error) return { success: false, error: error.message };
    caseId   = (data as TrustRiskCase).id;
    caseData = data as TrustRiskCase;
  }

  // Write individual signal event rows for granular querying.
  const signalRows = signals.map((s) => ({
    case_id:     caseId,
    user_id:     userId,
    signal:      s.signal,
    score:       s.score,
    detail:      s.detail,
    source_type: s.sourceType ?? null,
    source_id:   s.sourceId  ?? null,
  }));

  await supabase.from('trust_signal_events').insert(signalRows).then(() => {}).catch((e: unknown) =>
    console.warn('[TrustRisk] Signal event insert failed:', e),
  );

  // Notify moderators of the new/updated case (non-fatal).
  notifyModeratorsOfCase(caseData).catch((e: unknown) =>
    console.warn('[TrustRisk] Moderator notification failed:', e),
  );

  // Notify the affected user when an active automated action is applied.
  if (caseData.action_active && caseData.automated_action !== 'none') {
    notifyUserOfAction(caseData).catch((e: unknown) =>
      console.warn('[TrustRisk] User action notification failed:', e),
    );
  }

  return { success: true, data: caseData };
}

// ─── Pre-built signal collectors ─────────────────────────────────────────────

/**
 * Collect signals for a user from existing platform data.
 *
 * Queries: reports, bookings (disputes + cancellations), reviews.
 * Returns a flat array of SignalInput ready to pass to evaluateSignals().
 */
export async function collectSignalsForUser(userId: string): Promise<SignalInput[]> {
  const signals: SignalInput[] = [];
  const now = new Date();

  // ── Repeated reports (last 30 days) ───────────────────────────────────────
  const since30 = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const { count: reportCount } = await supabase
    .from('reports')
    .select('id', { count: 'exact', head: true })
    .eq('target_id', userId)
    .gte('created_at', since30);

  if ((reportCount ?? 0) >= 3) {
    signals.push({
      signal: 'repeated_reports',
      score: 15,
      detail: `${reportCount} reports received against this user in the past 30 days.`,
      sourceType: 'report',
    });
  }

  // ── Dispute history (last 90 days) ────────────────────────────────────────
  const since90 = new Date(now.getTime() - 90 * 86_400_000).toISOString();
  const { data: disputes } = await supabase
    .from('booking_status_history')
    .select('booking_id')
    .eq('status', 'Disputed')
    .gte('created_at', since90);

  // Filter to bookings where the user is the tenant
  if (disputes && disputes.length > 0) {
    const disputeBookingIds = (disputes as Array<{ booking_id: string }>).map((d) => d.booking_id);
    const { count: tenantDisputes } = await supabase
      .from('bookings')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', userId)
      .in('id', disputeBookingIds);

    const dc = tenantDisputes ?? 0;
    if (dc >= 3) {
      signals.push({
        signal: 'dispute_history_high',
        score: 20,
        detail: `${dc} disputes raised by this user as tenant in the past 90 days.`,
        sourceType: 'booking',
      });
    } else if (dc === 2) {
      signals.push({
        signal: 'dispute_history_medium',
        score: 10,
        detail: `${dc} disputes raised by this user as tenant in the past 90 days.`,
        sourceType: 'booking',
      });
    }
  }

  // ── Multiple late cancellations (last 30 days) ────────────────────────────
  const { count: cancelCount } = await supabase
    .from('bookings')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', userId)
    .eq('status', 'Cancelled')
    .gte('cancelled_at', since30);

  if ((cancelCount ?? 0) >= 5) {
    signals.push({
      signal: 'multiple_cancellations',
      score: 10,
      detail: `${cancelCount} cancellations by this user in the past 30 days.`,
      sourceType: 'booking',
    });
  }

  // ── Suspicious review pattern (last 24 h) ────────────────────────────────
  const since24h = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const { data: recentReviews } = await supabase
    .from('reviews')
    .select('id, rating')
    .eq('reviewer_id', userId)
    .gte('created_at', since24h);

  if (recentReviews) {
    const rr = recentReviews as Array<{ id: string; rating: number }>;
    const allOnestar = rr.length > 0 && rr.every((r) => r.rating === 1);
    if (rr.length >= 5 || allOnestar) {
      signals.push({
        signal: 'suspicious_review_pattern',
        score: 20,
        detail: allOnestar
          ? `${rr.length} reviews submitted in 24 h — all rated 1 star.`
          : `${rr.length} reviews submitted within 24 hours.`,
        sourceType: 'review',
      });
    }
  }

  return signals;
}

// ─── Targeted signal emitters (called from domain events) ────────────────────

/**
 * Record that a chargeback was filed against the given user.
 * Chargebacks are high-score signals; one alone can push a user to high risk.
 */
export async function recordChargebackSignal(
  userId: string,
  sourceId?: string,
): Promise<ServiceResponse<TrustRiskCase | null>> {
  return evaluateSignals({
    userId,
    signals: [
      {
        signal:     'chargeback_filed',
        score:      40,
        detail:     'A payment chargeback was filed associated with this account.',
        sourceType: 'payment',
        sourceId,
      },
    ],
  });
}

/**
 * Record a failed identity / KYC check for the given user.
 */
export async function recordFailedIdentitySignal(
  userId: string,
  sourceId?: string,
): Promise<ServiceResponse<TrustRiskCase | null>> {
  return evaluateSignals({
    userId,
    signals: [
      {
        signal:     'failed_identity_check',
        score:      25,
        detail:     'An identity verification check failed for this account.',
        sourceType: 'identity_check',
        sourceId,
      },
    ],
  });
}

/**
 * Run a full signal collection pass for a user and evaluate the result.
 * This is the batch path called from booking completion, report submission,
 * and the nightly risk-sweep scheduler pass.
 */
export async function runRiskEvaluation(
  userId: string,
): Promise<ServiceResponse<TrustRiskCase | null>> {
  const signals = await collectSignalsForUser(userId);
  if (!signals.length) return { success: true, data: null };
  return evaluateSignals({ userId, signals });
}

// ─── Case management (read) ───────────────────────────────────────────────────

export async function getCaseById(
  caseId: string,
): Promise<ServiceResponse<TrustRiskCase>> {
  const { data, error } = await supabase
    .from('trust_risk_cases')
    .select('*')
    .eq('id', caseId)
    .single();

  if (error || !data) return { success: false, error: 'Case not found' };
  return { success: true, data: data as TrustRiskCase };
}

export async function listCases(filters?: {
  status?: CaseStatus;
  riskLevel?: RiskLevel;
  userId?: string;
  limit?: number;
  offset?: number;
}): Promise<ServiceResponse<TrustRiskCase[]>> {
  const limit  = Math.min(filters?.limit  ?? 50, 200);
  const offset = filters?.offset ?? 0;

  let query = supabase.from('trust_risk_cases').select('*');

  if (filters?.status)    query = query.eq('status', filters.status);
  if (filters?.riskLevel) query = query.eq('risk_level', filters.riskLevel);
  if (filters?.userId)    query = query.eq('user_id', filters.userId);

  const { data, error } = await query
    .order('risk_level', { ascending: false })
    .order('created_at', { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) return { success: false, error: error.message };
  return { success: true, data: (data ?? []) as TrustRiskCase[] };
}

export async function getCasesForUser(
  userId: string,
): Promise<ServiceResponse<TrustRiskCase[]>> {
  return listCases({ userId });
}

// ─── Case management (write) ──────────────────────────────────────────────────

/** Assign a case to a moderator for review. */
export async function assignCase(
  caseId: string,
  moderatorId: string,
): Promise<ServiceResponse<TrustRiskCase>> {
  const { data, error } = await supabase
    .from('trust_risk_cases')
    .update({ assigned_to: moderatorId, status: 'under_review' })
    .eq('id', caseId)
    .select()
    .single();

  if (error || !data) return { success: false, error: error?.message ?? 'Case not found' };
  await auditRecord(moderatorId, 'trust_case.assign', 'trust_risk_case', caseId, { moderatorId });
  return { success: true, data: data as TrustRiskCase };
}

/** Resolve a case with a moderator note. */
export async function resolveCase(
  caseId: string,
  moderatorId: string,
  resolutionNote: string,
): Promise<ServiceResponse<TrustRiskCase>> {
  if (!resolutionNote?.trim()) {
    return { success: false, error: 'resolution_note is required' };
  }

  const { data, error } = await supabase
    .from('trust_risk_cases')
    .update({
      status:          'resolved',
      resolved_by:     moderatorId,
      resolved_at:     new Date().toISOString(),
      resolution_note: resolutionNote.trim(),
      action_active:   false,
    })
    .eq('id', caseId)
    .select()
    .single();

  if (error || !data) return { success: false, error: error?.message ?? 'Case not found' };
  await auditRecord(moderatorId, 'trust_case.resolve', 'trust_risk_case', caseId, { resolutionNote });
  return { success: true, data: data as TrustRiskCase };
}

/**
 * Override a case's automated action.
 *
 * Actions:
 *   'lifted'    — remove the automated hold/verification requirement
 *   'escalated' — escalate to a higher severity (e.g. manual suspension)
 *   'suspended' — apply a full account suspension (requires admin role)
 *   'cleared'   — mark as false positive, lift action, close case, notify user
 */
export async function overrideCase(
  caseId: string,
  actorId: string,
  action: OverrideAction,
  reason: string,
): Promise<ServiceResponse<TrustRiskCase>> {
  if (!reason?.trim()) {
    return { success: false, error: 'override reason is required' };
  }
  if (!(['lifted', 'escalated', 'suspended', 'cleared'] as OverrideAction[]).includes(action)) {
    return { success: false, error: 'Invalid override action' };
  }

  const updates: Record<string, unknown> = {
    override_action: action,
    override_by:     actorId,
    override_at:     new Date().toISOString(),
    override_reason: reason.trim(),
    status:          'overridden',
    action_active:   false,
  };

  if (action === 'cleared') {
    updates.false_positive = true;
    updates.status         = 'closed';
  }

  if (action === 'suspended') {
    // Escalate: keep action_active true so downstream checks can read it.
    updates.action_active = true;
    updates.status        = 'under_review';
  }

  const { data, error } = await supabase
    .from('trust_risk_cases')
    .update(updates)
    .eq('id', caseId)
    .select()
    .single();

  if (error || !data) return { success: false, error: error?.message ?? 'Case not found' };

  const updated = data as TrustRiskCase;

  await auditRecord(actorId, `trust_case.override.${action}`, 'trust_risk_case', caseId, {
    action,
    reason,
  });

  // Notify user when cleared (false positive recovery).
  if (action === 'cleared') {
    notifyUserCaseCleared(updated.user_id, caseId).catch((e: unknown) =>
      console.warn('[TrustRisk] User cleared notification failed:', e),
    );
  }

  return { success: true, data: updated };
}

// ─── Helpers — notifications ──────────────────────────────────────────────────

async function notifyModeratorsOfCase(riskCase: TrustRiskCase): Promise<void> {
  const { createNotification, shouldSendInApp } = await import('./notification.service.js');

  const { data: admins } = await supabase
    .from('users')
    .select('id')
    .in('role', ['admin', 'moderator']);

  if (!admins) return;

  for (const admin of admins as Array<{ id: string }>) {
    try {
      const send = await shouldSendInApp(admin.id, 'system_alert');
      if (!send) continue;
      await createNotification(admin.id, 'system_alert', {
        alertType:   'trust_risk_case',
        caseId:      riskCase.id,
        userId:      riskCase.user_id,
        riskLevel:   riskCase.risk_level,
        totalScore:  riskCase.total_score,
        action:      riskCase.automated_action,
        signalCount: (riskCase.signals ?? []).length,
        message:     `Risk case opened for user ${riskCase.user_id} — level: ${riskCase.risk_level}`,
      });
    } catch (err) {
      console.error(`[TrustRisk] Failed to notify moderator ${admin.id}:`, err);
    }
  }
}

async function notifyUserCaseCleared(userId: string, caseId: string): Promise<void> {
  const { enqueue } = await import('./notificationOutbox.service.js');
  await enqueue({
    userId,
    type:           'trust_case_cleared',
    idempotencyKey: `trust_case_cleared:${caseId}:${userId}`,
    channels:       ['in_app', 'email'],
    sourceEvent:    'trust_case.override.cleared',
    sourceId:       caseId,
    data: {
      caseId,
      message:
        'Your account has been reviewed and cleared. No restrictions are in place. ' +
        'If you have questions, please contact support.',
    },
  });
}

/**
 * Enqueue a mandatory trust_case_action outbox notification when an automated
 * action is applied to a user's account.  Delivered via the outbox so it
 * survives server restarts and respects the user's mandatory_channel pref.
 */
async function notifyUserOfAction(riskCase: TrustRiskCase): Promise<void> {
  const actionMessages: Record<AutomatedAction, string> = {
    none: '',
    account_review:
      'Your account has been flagged for routine review by our trust team. ' +
      'No restrictions are currently in place. You will be notified of any outcome.',
    step_up_verification:
      'Additional identity verification is required on your account. ' +
      'Please complete the verification process to continue using the platform without restrictions.',
    temporary_hold:
      'A temporary hold has been placed on your account pending a trust review. ' +
      'You may not create new bookings or process payments until the review is complete. ' +
      'Our team will contact you shortly.',
  };

  const message = actionMessages[riskCase.automated_action];
  if (!message) return;

  const { enqueue } = await import('./notificationOutbox.service.js');
  await enqueue({
    userId:         riskCase.user_id,
    type:           'trust_case_action',
    idempotencyKey: `trust_case_action:${riskCase.id}:${riskCase.user_id}`,
    channels:       ['in_app', 'email'],
    sourceEvent:    'trust_risk_evaluation',
    sourceId:       riskCase.id,
    data: {
      caseId:    riskCase.id,
      riskLevel: riskCase.risk_level,
      action:    riskCase.automated_action,
      message,
    },
  });
}

// ─── Active-action lookup (for downstream checks) ────────────────────────────

/**
 * Returns true when the user has an active automated action that should
 * block or gate a sensitive operation (e.g. booking creation).
 *
 * Only 'temporary_hold' blocks hard; 'step_up_verification' and
 * 'account_review' are informational — downstream callers decide what to do.
 */
export async function getUserActiveAction(
  userId: string,
): Promise<ServiceResponse<{ action: AutomatedAction; caseId: string | null }>> {
  const { data, error } = await supabase
    .from('trust_risk_cases')
    .select('id, automated_action')
    .eq('user_id', userId)
    .eq('action_active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return { success: false, error: error.message };

  if (!data) return { success: true, data: { action: 'none', caseId: null } };

  const row = data as { id: string; automated_action: AutomatedAction };
  return { success: true, data: { action: row.automated_action, caseId: row.id } };
}
