/**
 * Report service — abuse reports against listings (properties) and reviews.
 */

import { supabase } from '../config/supabase.js';
import { createNotification, shouldSendInApp } from './notification.service.js';
import type { ServiceResponse } from './index.js';

export type ReportTargetType = 'property' | 'review';
export type ReportStatus = 'pending' | 'resolved' | 'dismissed' | 'escalated';
export type ReportSeverity = 'low' | 'medium' | 'high' | 'critical';
export type AppealStatus = 'none' | 'pending' | 'approved' | 'denied';
export const REPORT_REASONS = [
  'spam',
  'fraud',
  'inappropriate',
  'misleading',
  'harassment',
  'other',
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export interface Report {
  id: string;
  target_type: ReportTargetType;
  target_id: string;
  reporter_id: string;
  reason: ReportReason;
  details: string | null;
  status: ReportStatus;
  resolved_by: string | null;
  resolution_note: string | null;
  resolved_at: string | null;
  assigned_to: string | null;
  evidence?: unknown[];
  appeal_status?: AppealStatus;
  appeal_reason?: string | null;
  severity?: ReportSeverity;
  hide_property?: boolean;
  host_notified?: boolean;
  notify_host?: boolean;
  created_at: string;
  updated_at: string;
}

const UNIQUE_VIOLATION = '23505';

/**
 * Submit an abuse report for a property listing or review.
 * Duplicate reports (same reporter + target) are rejected as a conflict.
 */
export async function submitReport(
  reporterId: string,
  targetType: ReportTargetType,
  targetId: string,
  reason: ReportReason,
  details?: string,
): Promise<ServiceResponse<Report>> {
  if (!['property', 'review'].includes(targetType)) {
    return { success: false, error: 'target_type must be "property" or "review"' };
  }
  if (!REPORT_REASONS.includes(reason)) {
    return { success: false, error: `reason must be one of: ${REPORT_REASONS.join(', ')}` };
  }

  const { data, error } = await supabase
    .from('reports')
    .insert({
      target_type: targetType,
      target_id: targetId,
      reporter_id: reporterId,
      reason,
      details: details || null,
    })
    .select()
    .single();

  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      return {
        success: false,
        error: 'You have already reported this item',
        conflict: true,
        statusCode: 409,
      };
    }
    return { success: false, error: error.message };
  }

  await notifyModerators(data as Report);

  // ── Trust risk: report signal ────────────────────────────────────────────
  // Run a full signal evaluation for the reported user fire-and-forget.
  // If this report pushes them over a threshold, a risk case is opened.
  runReportSignalEval(targetId).catch((err) =>
    console.warn('[ReportService] Post-report risk eval failed:', err),
  );

  return { success: true, data: data as Report };
}

/**
 * List reports, optionally filtered by status and/or target type.
 * Moderator-only.
 */
export async function listReports(filters?: {
  status?: ReportStatus;
  targetType?: ReportTargetType;
}): Promise<ServiceResponse<Report[]>> {
  let query = supabase.from('reports').select('*');

  if (filters?.status) {
    query = query.eq('status', filters.status);
  }
  if (filters?.targetType) {
    query = query.eq('target_type', filters.targetType);
  }

  const { data, error } = await query.order('created_at', { ascending: false });

  if (error) return { success: false, error: error.message };
  return { success: true, data: (data ?? []) as Report[] };
}

/**
 * Resolve or dismiss a report. Moderator-only.
 */
export async function resolveReport(
  reportId: string,
  resolverId: string,
  status: Extract<ReportStatus, 'resolved' | 'dismissed'>,
  resolutionNote?: string,
): Promise<ServiceResponse<Report>> {
  if (status !== 'resolved' && status !== 'dismissed') {
    return { success: false, error: 'status must be "resolved" or "dismissed"' };
  }

  const { data, error } = await supabase
    .from('reports')
    .update({
      status,
      resolved_by: resolverId,
      resolution_note: resolutionNote || null,
      resolved_at: new Date().toISOString(),
    })
    .eq('id', reportId)
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  if (!data) return { success: false, error: 'Report not found' };

  const { record } = await import('./auditLog.service.js');
  await record(resolverId, `report.${status}`, 'report', reportId, { resolutionNote });

  // ── Outbox: notify the target user of the resolution ─────────────────────
  // The resolved report may relate to a property (owner) or a review (author).
  // We notify whichever user was the target of the report so they know the
  // outcome.  This is a mandatory dispute_update notification.
  enqueueReportResolutionNotification(data as Report, status).catch((err) =>
    console.warn('[ReportService] Resolution outbox enqueue failed:', err),
  );

  return { success: true, data: data as Report };
}

/**
 * Fan out an in-app notification to every admin user when a new report comes in.
 * One recipient's failure never aborts notifying the rest.
 */
async function notifyModerators(report: Report): Promise<void> {
  const { data: admins, error } = await supabase.from('users').select('id').eq('role', 'admin');
  if (error || !admins) return;

  for (const admin of admins as Array<{ id: string }>) {
    try {
      const send = await shouldSendInApp(admin.id, 'report_created');
      if (!send) continue;
      await createNotification(admin.id, 'report_created', {
        reportId: report.id,
        targetType: report.target_type,
        targetId: report.target_id,
        reason: report.reason,
      });
    } catch (err) {
      console.error(`[notifyModerators] Failed to notify admin ${admin.id}:`, err);
    }
  }
}

/**
 * Assign a report to a moderator for handling.
 */
export async function assignReport(
  reportId: string,
  moderatorId: string,
): Promise<ServiceResponse<Report>> {
  const { data, error } = await supabase
    .from('reports')
    .update({ assigned_to: moderatorId })
    .eq('id', reportId)
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  if (!data) return { success: false, error: 'Report not found' };

  return { success: true, data: data as Report };
}

/**
 * Set report severity (for triage prioritization).
 */
export async function setSeverity(
  reportId: string,
  severity: ReportSeverity,
): Promise<ServiceResponse<Report>> {
  if (!['low', 'medium', 'high', 'critical'].includes(severity)) {
    return { success: false, error: 'Invalid severity level' };
  }

  const { data, error } = await supabase
    .from('reports')
    .update({ severity })
    .eq('id', reportId)
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  return { success: true, data: data as Report };
}

/**
 * Add evidence to a report (images, screenshots, links).
 */
export async function addEvidence(
  reportId: string,
  evidence: { type: string; url: string; description?: string },
): Promise<ServiceResponse<Report>> {
  // Fetch current report to get existing evidence
  const { data: report } = await supabase
    .from('reports')
    .select('evidence')
    .eq('id', reportId)
    .single();

  if (!report) {
    return { success: false, error: 'Report not found' };
  }

  const currentEvidence = report.evidence || [];
  const updatedEvidence = [...currentEvidence, evidence];

  const { data, error } = await supabase
    .from('reports')
    .update({ evidence: updatedEvidence })
    .eq('id', reportId)
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  return { success: true, data: data as Report };
}

/**
 * Hide a property from search when report is severe.
 */
export async function hideProperty(
  reportId: string,
): Promise<ServiceResponse<Report>> {
  const { data, error } = await supabase
    .from('reports')
    .update({ hide_property: true })
    .eq('id', reportId)
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  const report = data as Report;

  // Also hide the property in the properties table
  if (report.target_type === 'property') {
    await supabase
      .from('properties')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', report.target_id);
  }

  return { success: true, data: report };
}

/**
 * Unhide a property after successful appeal.
 */
export async function unhideProperty(
  reportId: string,
): Promise<ServiceResponse<Report>> {
  const { data, error } = await supabase
    .from('reports')
    .update({ hide_property: false })
    .eq('id', reportId)
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  const report = data as Report;

  // Restore the property
  if (report.target_type === 'property') {
    await supabase
      .from('properties')
      .update({ deleted_at: null })
      .eq('id', report.target_id);
  }

  return { success: true, data: report };
}

/**
 * Record host notification when report is escalated/resolved.
 */
export async function notifyHost(
  reportId: string,
  hostId: string,
  message: string,
): Promise<ServiceResponse<Report>> {
  // Update report to mark host as notified
  const { data, error } = await supabase
    .from('reports')
    .update({ host_notified: true })
    .eq('id', reportId)
    .select()
    .single();

  if (error) return { success: false, error: error.message };

  // Send notification
  try {
    await createNotification(hostId, 'report_notification', {
      reportId,
      message,
    });
  } catch (err) {
    console.error('[notifyHost] Failed to notify host:', err);
  }

  return { success: true, data: data as Report };
}

/**
 * Submit an appeal for a hidden property.
 */
export async function submitAppeal(
  reportId: string,
  hostId: string,
  appealReason: string,
): Promise<ServiceResponse<Report>> {
  const { data, error } = await supabase
    .from('reports')
    .update({
      appeal_status: 'pending',
      appeal_reason: appealReason,
    })
    .eq('id', reportId)
    .select()
    .single();

  if (error) return { success: false, error: error.message };

  // Notify moderators of appeal
  const { data: admins } = await supabase.from('users').select('id').eq('role', 'admin');
  if (admins) {
    for (const admin of admins as Array<{ id: string }>) {
      try {
        await createNotification(admin.id, 'appeal_submitted', {
          reportId,
          hostId,
          appealReason,
        });
      } catch {
        // Ignore notification failures
      }
    }
  }

  return { success: true, data: data as Report };
}

/**
 * Review and approve/deny an appeal.
 */
export async function reviewAppeal(
  reportId: string,
  moderatorId: string,
  approved: boolean,
): Promise<ServiceResponse<Report>> {
  const status = approved ? 'approved' : 'denied';

  const { data: report, error: fetchError } = await supabase
    .from('reports')
    .select('*')
    .eq('id', reportId)
    .single();

  if (fetchError || !report) {
    return { success: false, error: 'Report not found' };
  }

  const updateData: Record<string, unknown> = {
    appeal_status: status,
  };

  // If approved, unhide the property
  if (approved && report.hide_property) {
    updateData.hide_property = false;
    // Also restore in properties table
    if (report.target_type === 'property') {
      await supabase
        .from('properties')
        .update({ deleted_at: null })
        .eq('id', report.target_id);
    }
  }

  const { data, error } = await supabase
    .from('reports')
    .update(updateData)
    .eq('id', reportId)
    .select()
    .single();

  if (error) return { success: false, error: error.message };

  // Log the decision
  const { record } = await import('./auditLog.service.js');
  await record(moderatorId, `appeal.${status}`, 'report', reportId, {});

  return { success: true, data: data as Report };
}

/**
 * Get reports by severity for triage.
 */
export async function getReportsBySeverity(
  severity: ReportSeverity,
): Promise<ServiceResponse<Report[]>> {
  const { data, error } = await supabase
    .from('reports')
    .select('*')
    .eq('severity', severity)
    .eq('status', 'pending')
    .order('created_at', { ascending: true });

  if (error) return { success: false, error: error.message };
  return { success: true, data: (data ?? []) as Report[] };
}

/**
 * Get a report's impact — how many reports on this target from different reporters.
 */
export async function getReportImpact(
  targetType: ReportTargetType,
  targetId: string,
): Promise<ServiceResponse<{ count: number; unique_reporters: number }>> {
  const { data, error, count } = await supabase
    .from('reports')
    .select('reporter_id', { count: 'exact' })
    .eq('target_type', targetType)
    .eq('target_id', targetId)
    .eq('status', 'pending');

  if (error) return { success: false, error: error.message };

  const uniqueReporters = data ? new Set((data as { reporter_id: string }[]).map((r) => r.reporter_id)).size : 0;

  return {
    success: true,
    data: {
      count: count ?? 0,
      unique_reporters: uniqueReporters,
    },
  };
}

// ─── Internal: trust risk signal evaluation ───────────────────────────────────

/**
 * Run a full risk evaluation for the target user after a new report is filed.
 * Called fire-and-forget — must never block the report submission response.
 */
async function runReportSignalEval(targetUserId: string): Promise<void> {
  try {
    const { runRiskEvaluation } = await import('./trustRisk.service.js');
    const result = await runRiskEvaluation(targetUserId);
    if (result.success && result.data) {
      console.log(
        `[ReportService] Trust case created/updated for user ${targetUserId} ` +
        `after new report — level: ${result.data.risk_level}`,
      );
    }
  } catch (err) {
    console.warn('[ReportService] Trust risk eval error:', err);
  }
}

// ─── Internal: outbox helpers ─────────────────────────────────────────────────

/**
 * Enqueue a mandatory dispute_update notification for the user whose content
 * was the subject of the resolved report.
 *
 * For property reports the target is the property owner.
 * For review reports the target is the review author.
 */
async function enqueueReportResolutionNotification(
  report: Report,
  resolution: 'resolved' | 'dismissed',
): Promise<void> {
  try {
    // Resolve the user to notify.
    let recipientId: string | null = null;

    if (report.target_type === 'property') {
      const { data: prop } = await supabase
        .from('properties')
        .select('owner_id')
        .eq('id', report.target_id)
        .maybeSingle();
      recipientId = (prop as { owner_id?: string } | null)?.owner_id ?? null;
    } else if (report.target_type === 'review') {
      const { data: rev } = await supabase
        .from('reviews')
        .select('reviewer_id')
        .eq('id', report.target_id)
        .maybeSingle();
      recipientId = (rev as { reviewer_id?: string } | null)?.reviewer_id ?? null;
    }

    if (!recipientId) return;

    const outcomeMessage =
      resolution === 'resolved'
        ? 'A report concerning your content has been reviewed and actioned by our trust team.'
        : 'A report concerning your content was reviewed and dismissed — no action has been taken.';

    const { enqueue } = await import('./notificationOutbox.service.js');
    await enqueue({
      userId:         recipientId,
      type:           'dispute_update',
      idempotencyKey: `report_resolution:${report.id}:${recipientId}`,
      channels:       ['in_app', 'email'],
      sourceEvent:    `report.${resolution}`,
      sourceId:       report.id,
      data: {
        reportId:   report.id,
        resolution,
        message:    outcomeMessage,
      },
    });
  } catch (err) {
    console.warn('[ReportService] enqueueReportResolutionNotification error:', err);
  }
}
