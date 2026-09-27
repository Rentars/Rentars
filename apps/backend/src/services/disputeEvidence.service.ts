/**
 * Dispute evidence — secure uploads attached to disputed bookings.
 *
 * Enforces type allowlists, size limits, malware scanning (magic-byte / image validation),
 * participant vs moderator visibility, retention, and audit logging.
 */

import crypto from 'node:crypto';
import { supabase } from '@/config/supabase.js';
import {
  getDisputeEvidenceSignedUrl,
  removeDisputeEvidenceObject,
  uploadDisputeEvidenceObject,
} from '@/config/supabase-storage.js';
import { env } from '@/config/env.js';
import { detectFileType, validateImage } from '@/services/fileUpload.service.js';
import { auditLogger } from '@/services/auditLogger.service.js';
import { bookingAuthorizationService } from '@/services/bookingAuthorization.service.js';
import type { ServiceResponse } from './index.js';

export const ALLOWED_EVIDENCE_TYPES = [
  'image',
  'document',
  'message_export',
  'payment_proof',
] as const;

export type EvidenceType = (typeof ALLOWED_EVIDENCE_TYPES)[number];
export type EvidenceVisibility = 'participant' | 'moderator_only';
export type ScanStatus = 'pending' | 'clean' | 'blocked';

export const MAX_DOCUMENT_SIZE_BYTES = 10 * 1024 * 1024;
export const EVIDENCE_SIGNED_URL_TTL_SECONDS = 3600;

/** Align with financial/dispute record retention (7 years). */
export const DEFAULT_EVIDENCE_RETENTION_DAYS = 7 * 365;

const SENSITIVE_METADATA_KEYS = new Set([
  'storage_path',
  'internal_path',
  'uploader_ip',
  'raw_filename',
  'scan_details',
]);

export interface DisputeEvidenceRow {
  id: string;
  booking_id: string;
  uploader_id: string;
  evidence_type: EvidenceType;
  storage_path: string;
  mime_type: string;
  size_bytes: number;
  visibility: EvidenceVisibility;
  scan_status: ScanStatus;
  retention_until: string;
  anonymized_at: string | null;
  deleted_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export type DisputeEvidencePublic = Omit<DisputeEvidenceRow, 'storage_path'> & {
  storage_path?: never;
};

function retentionUntilFromNow(days: number = DEFAULT_EVIDENCE_RETENTION_DAYS): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').toLowerCase() || 'file';
}

export function generateDisputeEvidenceStoragePath(
  bookingId: string,
  evidenceId: string,
  fileName: string,
): string {
  return `bookings/${bookingId}/${evidenceId}/${Date.now()}-${sanitizeFileName(fileName)}`;
}

function isPdf(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.slice(0, 4).toString('ascii') === '%PDF';
}

function isPlainTextOrJson(buffer: Buffer, mimeType: string): boolean {
  if (mimeType === 'application/json') {
    const trimmed = buffer.toString('utf-8').trim();
    return trimmed.startsWith('{') || trimmed.startsWith('[');
  }
  if (mimeType === 'text/plain') {
    return !buffer.includes(0);
  }
  return false;
}

/**
 * Malware / content scan stub: magic-byte checks and image validation.
 */
export async function scanEvidenceFile(
  buffer: Buffer,
  evidenceType: EvidenceType,
  mimeType: string,
): Promise<{ scan_status: ScanStatus; error?: string }> {
  const detected = await detectFileType(buffer);

  if (detected === 'exe' || detected === 'zip') {
    return { scan_status: 'blocked', error: 'Executable or archive files are not allowed' };
  }

  if (evidenceType === 'image' || evidenceType === 'payment_proof') {
    if (mimeType.startsWith('image/')) {
      const result = await validateImage(buffer, {
        maxSizeBytes: env.MAX_IMAGE_SIZE_BYTES,
        minWidth: 1,
        minHeight: 1,
        allowedFormats: ['jpeg', 'png', 'webp'],
      });
      if (!result.valid) {
        return { scan_status: 'blocked', error: result.error ?? 'Image validation failed' };
      }
      return { scan_status: 'clean' };
    }
    if (mimeType === 'application/pdf' && evidenceType === 'payment_proof') {
      if (!isPdf(buffer)) {
        return { scan_status: 'blocked', error: 'Invalid PDF file' };
      }
      return { scan_status: 'clean' };
    }
  }

  if (evidenceType === 'document' || (evidenceType === 'payment_proof' && mimeType === 'application/pdf')) {
    if (mimeType !== 'application/pdf') {
      return { scan_status: 'blocked', error: 'Documents must be PDF' };
    }
    if (!isPdf(buffer)) {
      return { scan_status: 'blocked', error: 'Invalid PDF file' };
    }
    return { scan_status: 'clean' };
  }

  if (evidenceType === 'message_export') {
    if (!['application/json', 'text/plain'].includes(mimeType)) {
      return { scan_status: 'blocked', error: 'Message exports must be JSON or plain text' };
    }
    if (!isPlainTextOrJson(buffer, mimeType)) {
      return { scan_status: 'blocked', error: 'Invalid message export format' };
    }
    return { scan_status: 'clean' };
  }

  return { scan_status: 'blocked', error: 'Evidence type does not match file content' };
}

export function maxSizeForEvidenceType(type: EvidenceType): number {
  if (type === 'image') return env.MAX_IMAGE_SIZE_BYTES;
  return MAX_DOCUMENT_SIZE_BYTES;
}

export function redactEvidenceForParticipant(row: DisputeEvidenceRow): DisputeEvidencePublic {
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row.metadata ?? {})) {
    if (!SENSITIVE_METADATA_KEYS.has(key)) {
      metadata[key] = value;
    }
  }

  const { storage_path: _omit, ...rest } = row;
  return { ...rest, metadata };
}

async function bookingIsDisputed(bookingId: string): Promise<boolean> {
  const { data, error } = await supabase.from('bookings').select('status').eq('id', bookingId).single();
  if (error || !data) return false;
  return (data as { status: string }).status === 'Disputed';
}

async function isBookingUnderLegalHold(bookingId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('legal_holds')
    .select('id')
    .eq('entity_type', 'bookings')
    .eq('entity_id', bookingId)
    .eq('active', true)
    .limit(1);

  if (error) return false;
  return (data?.length ?? 0) > 0;
}

export async function attachEvidence(
  bookingId: string,
  uploaderId: string,
  file: Express.Multer.File,
  type: EvidenceType,
  visibility: EvidenceVisibility = 'participant',
): Promise<ServiceResponse<DisputeEvidencePublic>> {
  if (!ALLOWED_EVIDENCE_TYPES.includes(type)) {
    return { success: false, error: `evidence_type must be one of: ${ALLOWED_EVIDENCE_TYPES.join(', ')}` };
  }

  if (!['participant', 'moderator_only'].includes(visibility)) {
    return { success: false, error: 'visibility must be participant or moderator_only' };
  }

  const auth = await bookingAuthorizationService.canDispute(bookingId, uploaderId);
  if (!auth.allowed) {
    return { success: false, error: auth.reason ?? 'Forbidden' };
  }

  if (!(await bookingIsDisputed(bookingId))) {
    return { success: false, error: 'Evidence can only be attached while the booking is disputed' };
  }

  const maxSize = maxSizeForEvidenceType(type);
  if (file.buffer.length > maxSize) {
    return { success: false, error: `File exceeds maximum size of ${maxSize} bytes for type ${type}` };
  }

  const scan = await scanEvidenceFile(file.buffer, type, file.mimetype);
  if (scan.scan_status === 'blocked') {
    await auditLogger.log({
      actorId: uploaderId,
      action: 'evidence.upload',
      resourceType: 'dispute',
      resourceId: bookingId,
      success: false,
      error: scan.error,
      meta: { evidence_type: type, scan_status: 'blocked' },
    });
    return { success: false, error: scan.error ?? 'File blocked by security scan' };
  }

  const evidenceId = crypto.randomUUID();
  const storagePath = generateDisputeEvidenceStoragePath(bookingId, evidenceId, file.originalname);

  try {
    await uploadDisputeEvidenceObject(storagePath, file.buffer, file.mimetype);
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Upload failed',
    };
  }

  const { data, error } = await supabase
    .from('dispute_evidence')
    .insert({
      id: evidenceId,
      booking_id: bookingId,
      uploader_id: uploaderId,
      evidence_type: type,
      storage_path: storagePath,
      mime_type: file.mimetype,
      size_bytes: file.buffer.length,
      visibility,
      scan_status: scan.scan_status,
      retention_until: retentionUntilFromNow(),
      metadata: {
        original_name: sanitizeFileName(file.originalname),
      },
    })
    .select()
    .single();

  if (error) {
    await removeDisputeEvidenceObject(storagePath).catch(() => undefined);
    return { success: false, error: error.message };
  }

  const row = data as DisputeEvidenceRow;

  await auditLogger.log({
    actorId: uploaderId,
    action: 'evidence.upload',
    resourceType: 'dispute',
    resourceId: bookingId,
    meta: {
      evidence_id: row.id,
      evidence_type: type,
      visibility,
      size_bytes: row.size_bytes,
    },
  });

  return { success: true, data: redactEvidenceForParticipant(row) };
}

function baseEvidenceQuery(bookingId: string) {
  return supabase
    .from('dispute_evidence')
    .select('*')
    .eq('booking_id', bookingId)
    .is('deleted_at', null)
    .eq('scan_status', 'clean')
    .order('created_at', { ascending: true });
}

export async function listEvidenceForParticipant(
  bookingId: string,
  userId: string,
  userRole?: string,
): Promise<ServiceResponse<DisputeEvidencePublic[]>> {
  const read = await bookingAuthorizationService.canRead(bookingId, userId, userRole);
  if (!read.allowed) {
    return { success: false, error: read.reason ?? 'Forbidden' };
  }

  const { data, error } = await baseEvidenceQuery(bookingId).eq('visibility', 'participant');

  if (error) return { success: false, error: error.message };

  const rows = (data ?? []) as DisputeEvidenceRow[];

  await auditLogger.log({
    actorId: userId,
    action: 'evidence.view',
    resourceType: 'dispute',
    resourceId: bookingId,
    meta: { role: 'participant', count: rows.length },
  });

  return { success: true, data: rows.map(redactEvidenceForParticipant) };
}

export async function listEvidenceForModerator(
  bookingId: string,
  userId: string,
): Promise<ServiceResponse<DisputeEvidenceRow[]>> {
  const { data, error } = await supabase
    .from('dispute_evidence')
    .select('*')
    .eq('booking_id', bookingId)
    .is('deleted_at', null)
    .neq('scan_status', 'blocked')
    .order('created_at', { ascending: true });

  if (error) return { success: false, error: error.message };

  const rows = (data ?? []) as DisputeEvidenceRow[];

  await auditLogger.log({
    actorId: userId,
    action: 'evidence.view',
    resourceType: 'dispute',
    resourceId: bookingId,
    meta: { role: 'moderator', count: rows.length },
  });

  return { success: true, data: rows };
}

export async function getEvidenceDownloadUrl(
  bookingId: string,
  evidenceId: string,
  userId: string,
  userRole?: string,
  options?: { ip?: string },
): Promise<ServiceResponse<{ url: string; expires_in_seconds: number }>> {
  const { data: row, error } = await supabase
    .from('dispute_evidence')
    .select('*')
    .eq('id', evidenceId)
    .eq('booking_id', bookingId)
    .is('deleted_at', null)
    .single();

  if (error || !row) {
    return { success: false, error: 'Evidence not found' };
  }

  const evidence = row as DisputeEvidenceRow;

  if (evidence.scan_status !== 'clean' || evidence.anonymized_at) {
    return { success: false, error: 'Evidence is not available for download' };
  }

  if (new Date(evidence.retention_until).getTime() < Date.now()) {
    return { success: false, error: 'Evidence retention period has expired' };
  }

  const isModerator = userRole === 'admin' || userRole === 'moderator';

  if (!isModerator) {
    const read = await bookingAuthorizationService.canRead(bookingId, userId, userRole);
    if (!read.allowed) {
      return { success: false, error: read.reason ?? 'Forbidden' };
    }
    if (evidence.visibility === 'moderator_only') {
      return { success: false, error: 'Forbidden: moderator-only evidence' };
    }
  }

  try {
    const url = await getDisputeEvidenceSignedUrl(
      evidence.storage_path,
      EVIDENCE_SIGNED_URL_TTL_SECONDS,
    );

    await auditLogger.log({
      actorId: userId,
      action: 'evidence.download',
      resourceType: 'dispute',
      resourceId: bookingId,
      ip: options?.ip,
      meta: { evidence_id: evidenceId, moderator: isModerator },
    });

    return {
      success: true,
      data: { url, expires_in_seconds: EVIDENCE_SIGNED_URL_TTL_SECONDS },
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to generate download URL',
    };
  }
}

export interface PurgeExpiredEvidenceResult {
  purged: number;
  anonymized: number;
  held_skipped: number;
}

/**
 * Remove storage for expired evidence and anonymize DB rows.
 * Skips bookings under an active legal hold.
 */
export async function purgeExpiredEvidence(
  batchSize: number = 100,
  dryRun: boolean = false,
): Promise<PurgeExpiredEvidenceResult> {
  const now = new Date().toISOString();

  const { data: expired, error } = await supabase
    .from('dispute_evidence')
    .select('id, booking_id, storage_path')
    .lt('retention_until', now)
    .is('deleted_at', null)
    .is('anonymized_at', null)
    .limit(batchSize);

  if (error || !expired?.length) {
    return { purged: 0, anonymized: 0, held_skipped: 0 };
  }

  let purged = 0;
  let anonymized = 0;
  let held_skipped = 0;

  for (const row of expired as Array<{ id: string; booking_id: string; storage_path: string }>) {
    if (await isBookingUnderLegalHold(row.booking_id)) {
      held_skipped += 1;
      continue;
    }

    if (dryRun) {
      anonymized += 1;
      continue;
    }

    try {
      await removeDisputeEvidenceObject(row.storage_path);
    } catch {
      // Continue anonymizing even if object already removed
    }

    const { error: updateError } = await supabase
      .from('dispute_evidence')
      .update({
        anonymized_at: now,
        deleted_at: now,
        storage_path: `redacted/${row.id}`,
        metadata: {},
      })
      .eq('id', row.id);

    if (!updateError) {
      anonymized += 1;
      purged += 1;
      await auditLogger.log({
        action: 'evidence.purge',
        resourceType: 'dispute',
        resourceId: row.booking_id,
        meta: { evidence_id: row.id, reason: 'retention_expired' },
      });
    }
  }

  return { purged, anonymized, held_skipped };
}

/** @deprecated Use purgeExpiredEvidence — retained for retention.service naming. */
export async function anonymizeExpired(batchSize?: number, dryRun?: boolean): Promise<PurgeExpiredEvidenceResult> {
  return purgeExpiredEvidence(batchSize, dryRun);
}
