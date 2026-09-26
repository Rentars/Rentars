import { supabase } from '@/config/supabase.js';
import { auditLogger } from './auditLogger.service.js';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';

export interface DataExportRequest {
  id: string;
  user_id: string;
  status: 'pending' | 'completed' | 'failed';
  export_url?: string;
  requested_at: string;
  completed_at?: string;
  expires_at: string;
  error_message?: string;
}

export interface DeletionRequest {
  id: string;
  user_id: string;
  status: 'pending' | 'completed' | 'cancelled' | 'failed';
  requested_at: string;
  cancelled_at?: string;
  completed_at?: string;
  cancel_token: string;
  cancel_expires_at: string;
  error_message?: string;
}

export async function verifyUserPassword(userId: string, password: string): Promise<boolean> {
  const { data: userData, error } = await supabase
    .from('users')
    .select('password_hash')
    .eq('id', userId)
    .single();

  if (error || !userData) return false;

  const bcrypt = await import('bcrypt');
  return bcrypt.compare(password, userData.password_hash);
}

export async function requestDataExport(userId: string, ip: string): Promise<DataExportRequest> {
  const exportId = uuid();
  const requestedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('data_exports')
    .insert({
      id: exportId,
      user_id: userId,
      status: 'pending',
      requested_at: requestedAt,
      expires_at: expiresAt,
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create export request: ${error.message}`);
  }

  await auditLogger.log({
    actorId: userId,
    action: 'privacy.data_export_requested',
    resourceType: 'user',
    resourceId: userId,
    ip,
    meta: { export_id: exportId },
  });

  return data;
}

export async function getDataExportStatus(
  userId: string,
  exportId: string,
): Promise<DataExportRequest | null> {
  const { data } = await supabase
    .from('data_exports')
    .select('*')
    .eq('id', exportId)
    .eq('user_id', userId)
    .single();

  return data || null;
}

export async function generateDataExport(userId: string): Promise<Record<string, unknown>> {
  const [profileResult, bookingsResult, reviewsResult, messagesResult, notificationPrefsResult] =
    await Promise.all([
      supabase.from('profiles').select('*').eq('id', userId).single(),
      supabase
        .from('bookings')
        .select(
          'id, property_id, check_in, check_out, guest_count, total_price, status, terms_version, terms_accepted_at, created_at',
        )
        .eq('tenant_id', userId),
      supabase
        .from('reviews')
        .select('id, property_id, rating, comment, created_at')
        .eq('author_id', userId),
      supabase
        .from('messages')
        .select('id, recipient_id, content, created_at')
        .eq('sender_id', userId),
      supabase
        .from('notification_preferences')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle(),
    ]);

  return {
    exported_at: new Date().toISOString(),
    note: 'Blockchain records (wallet addresses, transaction hashes, on-chain IDs) are permanently public on the Stellar ledger and are not included here. They cannot be deleted.',
    profile: profileResult.data ?? null,
    bookings: bookingsResult.data ?? [],
    reviews: reviewsResult.data ?? [],
    messages: messagesResult.data ?? [],
    notification_preferences: notificationPrefsResult.data ?? null,
  };
}

export async function requestAccountDeletion(userId: string, ip: string): Promise<DeletionRequest> {
  const deletionId = uuid();
  const cancelToken = jwt.sign(
    { deletion_id: deletionId, user_id: userId },
    process.env.JWT_SECRET || 'secret',
    { expiresIn: '7d' },
  );
  const requestedAt = new Date().toISOString();
  const cancelExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('account_deletions')
    .insert({
      id: deletionId,
      user_id: userId,
      status: 'pending',
      requested_at: requestedAt,
      cancel_token: cancelToken,
      cancel_expires_at: cancelExpiresAt,
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create deletion request: ${error.message}`);
  }

  await auditLogger.log({
    actorId: userId,
    action: 'privacy.account_deletion_requested',
    resourceType: 'user',
    resourceId: userId,
    ip,
    meta: { deletion_id: deletionId },
  });

  return data;
}

export async function getDeletionRequest(userId: string, deletionId: string): Promise<DeletionRequest | null> {
  const { data } = await supabase
    .from('account_deletions')
    .select('*')
    .eq('id', deletionId)
    .eq('user_id', userId)
    .single();

  return data || null;
}

export async function cancelAccountDeletion(userId: string, deletionId: string, ip: string): Promise<boolean> {
  const now = new Date().toISOString();

  const { data: deletion, error: fetchError } = await supabase
    .from('account_deletions')
    .select('*')
    .eq('id', deletionId)
    .eq('user_id', userId)
    .single();

  if (fetchError || !deletion) return false;

  if (deletion.status !== 'pending') return false;

  if (new Date(deletion.cancel_expires_at) < new Date()) return false;

  const { error: updateError } = await supabase
    .from('account_deletions')
    .update({
      status: 'cancelled',
      cancelled_at: now,
    })
    .eq('id', deletionId);

  if (updateError) return false;

  await auditLogger.log({
    actorId: userId,
    action: 'privacy.account_deletion_cancelled',
    resourceType: 'user',
    resourceId: userId,
    ip,
    meta: { deletion_id: deletionId },
  });

  return true;
}

export async function executeAccountDeletion(userId: string, deletionId: string, ip: string): Promise<void> {
  const deletedEmail = `deleted-${userId}@rentars.invalid`;
  const now = new Date().toISOString();

  const { error: userError } = await supabase
    .from('users')
    .update({
      email: deletedEmail,
      status: 'deleted',
      email_verified: false,
    })
    .eq('id', userId);

  if (userError) {
    await supabase
      .from('account_deletions')
      .update({
        status: 'failed',
        error_message: userError.message,
        completed_at: now,
      })
      .eq('id', deletionId);
    throw new Error(`Failed to anonymise account: ${userError.message}`);
  }

  const { error: profileError } = await supabase
    .from('profiles')
    .update({
      display_name: 'Deleted User',
      avatar_url: null,
      bio: null,
      stellar_address: null,
      phone: null,
      location: null,
    })
    .eq('id', userId);

  if (profileError) {
    console.error('[privacy] Failed to wipe profile for', userId, profileError.message);
  }

  await supabase.from('notifications').delete().eq('user_id', userId);
  await supabase.from('notification_preferences').delete().eq('user_id', userId);
  await supabase.from('push_subscriptions').delete().eq('user_id', userId);
  await supabase.from('refresh_tokens').delete().eq('user_id', userId);
  await supabase.from('saved_searches').delete().eq('user_id', userId);

  const { error: updateError } = await supabase
    .from('account_deletions')
    .update({
      status: 'completed',
      completed_at: now,
    })
    .eq('id', deletionId);

  if (updateError) {
    console.error('[privacy] Failed to update deletion status for', userId, updateError.message);
  }

  await auditLogger.log({
    actorId: userId,
    action: 'privacy.account_deletion_completed',
    resourceType: 'user',
    resourceId: userId,
    ip,
    meta: {
      deletion_id: deletionId,
      anonymised_email: deletedEmail,
      retained: ['bookings', 'payments', 'audit_logs', 'blockchain_records'],
    },
  });
}
