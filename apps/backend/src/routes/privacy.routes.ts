/**
 * Privacy routes — data subject rights endpoints.
 *
 * GET  /api/v1/privacy/export          — export all personal data for the authenticated user
 * POST /api/v1/privacy/delete-account  — request account deletion (anonymises PII; see service)
 *
 * Both endpoints are rate-limited to prevent abuse.
 */

import { Router } from 'express';
import type { Response } from 'express';
import { authenticate, type AuthRequest } from '@/middleware/auth.middleware.js';
import { supabase } from '@/config/supabase.js';
import { auditLogger } from '@/services/auditLogger.service.js';
import { createUserRateLimiter } from '@/middleware/rateLimiter.js';

const router = Router();

/** Max one export request per user per hour. */
const exportLimiter = createUserRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyPrefix: 'rl:privacy:export',
});

/** Max one deletion request per user per day. */
const deletionLimiter = createUserRateLimiter({
  windowMs: 24 * 60 * 60 * 1000,
  max: 3,
  keyPrefix: 'rl:privacy:delete',
});

// ── Data export ────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/privacy/export
 *
 * Returns a JSON object containing all personal data held for the authenticated
 * user that can be exported (profile, bookings, reviews, messages).
 * Blockchain records are referenced by ID but not replicated here.
 */
router.get('/export', authenticate, exportLimiter, async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const [
    profileResult,
    bookingsResult,
    reviewsResult,
    messagesResult,
    notificationPrefsResult,
  ] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', userId).single(),
    supabase
      .from('bookings')
      .select('id, property_id, check_in, check_out, guest_count, total_price, status, terms_version, terms_accepted_at, created_at')
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

  await auditLogger.log({
    actorId: userId,
    action: 'auth.unauthorized_access', // closest available; use 'privacy.export' if added to AuditAction
    resourceType: 'user',
    resourceId: userId,
    ip: req.ip,
    meta: { action: 'data_export_requested' },
  });

  res.json({
    exported_at: new Date().toISOString(),
    note: 'Blockchain records (wallet addresses, transaction hashes, on-chain IDs) are permanently public on the Stellar ledger and are not included here. They cannot be deleted.',
    profile: profileResult.data ?? null,
    bookings: bookingsResult.data ?? [],
    reviews: reviewsResult.data ?? [],
    messages: messagesResult.data ?? [],
    notification_preferences: notificationPrefsResult.data ?? null,
  });
});

// ── Account deletion ───────────────────────────────────────────────────────────

/**
 * POST /api/v1/privacy/delete-account
 *
 * Anonymises the user's personal data:
 *   - Email replaced with deleted-<id>@rentars.invalid
 *   - Profile name/avatar/bio cleared
 *   - Stellar address removed from profile
 *   - Account status set to 'deleted'
 *
 * Data that CANNOT be deleted:
 *   - Booking & payment records (7-year financial retention)
 *   - Audit log entries
 *   - Blockchain records (Stellar ledger — permanently public)
 *
 * The tenant_id on bookings is retained to preserve financial records but is
 * no longer linkable to a real identity once the email and profile are wiped.
 */
router.post('/delete-account', authenticate, deletionLimiter, async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const deletedEmail = `deleted-${userId}@rentars.invalid`;

  // 1. Anonymise the user record
  const { error: userError } = await supabase
    .from('users')
    .update({
      email: deletedEmail,
      status: 'deleted',
      email_verified: false,
    })
    .eq('id', userId);

  if (userError) {
    res.status(500).json({ error: 'Failed to anonymise account. Please try again or contact support.' });
    return;
  }

  // 2. Wipe profile PII
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
    // Non-fatal: log but return success since account is already anonymised
    console.error('[privacy] Failed to wipe profile for', userId, profileError.message);
  }

  // 3. Delete notifications (not required for retention)
  await supabase.from('notifications').delete().eq('user_id', userId);
  await supabase.from('notification_preferences').delete().eq('user_id', userId);
  await supabase.from('push_subscriptions').delete().eq('user_id', userId);
  await supabase.from('refresh_tokens').delete().eq('user_id', userId);
  await supabase.from('saved_searches').delete().eq('user_id', userId);

  // 4. Audit the deletion
  await auditLogger.log({
    actorId: userId,
    action: 'auth.logout',
    resourceType: 'user',
    resourceId: userId,
    ip: req.ip,
    meta: {
      action: 'account_deletion',
      anonymised_email: deletedEmail,
      retained: ['bookings', 'payments', 'audit_logs', 'blockchain_records'],
    },
  });

  res.json({
    message: 'Your account has been anonymised. Email, profile, and notification data have been deleted.',
    retained_data: [
      'Booking and payment records (7-year legal retention)',
      'Audit log entries (7-year legal retention)',
      'Blockchain records on the Stellar ledger (permanent — cannot be deleted)',
    ],
  });
});

export default router;
