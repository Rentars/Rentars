/**
 * Booking reminder service.
 *
 * Finds bookings whose check-in or check-out falls within a configurable
 * lead-time window and sends a `booking_reminder` notification to the
 * relevant parties (tenant + host), respecting per-user channel preferences.
 *
 * Idempotent: a `booking_reminders` row is inserted (or detected via the
 * unique constraint) before sending so the job can run repeatedly without
 * ever delivering a duplicate.
 *
 * Configuration (env):
 *   REMINDER_CHECKIN_HOURS   — hours before check-in  (default: 24)
 *   REMINDER_CHECKOUT_HOURS  — hours before check-out (default: 12)
 */

import { supabase } from '@/config/supabase.js';
import { createNotificationWithEmail, getPreferences } from './notification.service.js';
import type { ServiceResponse } from './index.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ReminderType =
  | 'checkin_tenant'
  | 'checkin_host'
  | 'checkout_tenant'
  | 'checkout_host';

export interface ReminderResult {
  sent:     number;
  skipped:  number;
  errors:   number;
}

// ─── Config ───────────────────────────────────────────────────────────────────

function getLeadTimeHours(): { checkIn: number; checkOut: number } {
  return {
    checkIn:  Number(process.env.REMINDER_CHECKIN_HOURS  ?? 24),
    checkOut: Number(process.env.REMINDER_CHECKOUT_HOURS ?? 12),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Mark a reminder as sent. Returns false if already sent (unique violation),
 * true on success, throws on unexpected errors.
 *
 * Uses atomic INSERT ... ON CONFLICT ... DO NOTHING to prevent race conditions
 * when multiple scheduler invocations run concurrently.
 */
export async function markReminderSent(
  bookingId: string,
  reminderType: ReminderType,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('booking_reminders')
    .insert({ booking_id: bookingId, reminder_type: reminderType })
    .select('id')
    .single();

  if (!error) return true;
  // 23505 = unique_violation — already sent
  if (error.code === '23505') return false;
  throw new Error(error.message);
}

/**
 * Check whether a reminder has already been sent (without inserting).
 */
export async function isReminderSent(
  bookingId: string,
  reminderType: ReminderType,
): Promise<boolean> {
  const { data } = await supabase
    .from('booking_reminders')
    .select('id')
    .eq('booking_id', bookingId)
    .eq('reminder_type', reminderType)
    .maybeSingle();

  return !!data;
}

/**
 * Fetch the email address for a user.
 */
async function getUserEmail(userId: string): Promise<string | null> {
  const { data } = await supabase
    .from('users')
    .select('email')
    .eq('id', userId)
    .single();
  return (data as { email?: string } | null)?.email ?? null;
}

/**
 * Send a single reminder notification if the user's preferences allow it.
 * Returns true if a notification was created.
 */
async function sendReminderIfAllowed(
  userId:      string,
  bookingId:   string,
  data:        Record<string, unknown>,
): Promise<boolean> {
  const prefs = await getPreferences(userId);
  if (prefs.success && prefs.data) {
    const typeEnabled = prefs.data.notification_types['booking_reminder'];
    if (typeEnabled === false) return false;
  }

  const email = await getUserEmail(userId);
  const result = await createNotificationWithEmail(userId, 'booking_reminder', {
    ...data,
    booking_id: bookingId,
    userEmail:  email ?? undefined,
  });

  return result.success;
}

// ─── Core scheduler logic ─────────────────────────────────────────────────────

/**
 * Find all active bookings whose check-in falls within the reminder window
 * and send reminders to tenant + host if not already sent.
 */
async function processCheckInReminders(
  leadHours: number,
  result: ReminderResult,
): Promise<void> {
  const now    = new Date();
  const windowEnd = new Date(now.getTime() + leadHours * 3_600_000);

  // Bookings where check_in is between now and windowEnd, status not cancelled
  const { data: bookings, error } = await supabase
    .from('bookings')
    .select(
      `id, tenant_id, check_in, check_out, total_price, guest_count,
       properties ( title, owner_id )`,
    )
    .gte('check_in', now.toISOString().slice(0, 10))
    .lte('check_in', windowEnd.toISOString().slice(0, 10))
    .not('status', 'eq', 'Cancelled');

  if (error || !bookings) return;

  for (const booking of bookings as Array<{
    id: string; tenant_id: string; check_in: string; check_out: string;
    total_price: number; guest_count: number;
    properties: { title: string; owner_id: string } | null;
  }>) {
    const propertyTitle = booking.properties?.title ?? 'your rental';
    const ownerId       = booking.properties?.owner_id;

    const notifData = {
      propertyTitle,
      checkIn:    booking.check_in,
      checkOut:   booking.check_out,
      totalPrice: booking.total_price,
      guestCount: booking.guest_count,
    };

    // Tenant reminder
    try {
      const alreadySent = !(await markReminderSent(booking.id, 'checkin_tenant'));
      if (alreadySent) {
        result.skipped++;
      } else {
        const sent = await sendReminderIfAllowed(booking.tenant_id, booking.id, {
          ...notifData, role: 'tenant', event: 'check_in',
        });
        sent ? result.sent++ : result.skipped++;
      }
    } catch {
      result.errors++;
    }

    // Host reminder
    if (ownerId) {
      try {
        const alreadySent = !(await markReminderSent(booking.id, 'checkin_host'));
        if (alreadySent) {
          result.skipped++;
        } else {
          const sent = await sendReminderIfAllowed(ownerId, booking.id, {
            ...notifData, role: 'host', event: 'check_in',
          });
          sent ? result.sent++ : result.skipped++;
        }
      } catch {
        result.errors++;
      }
    }
  }
}

/**
 * Find all active bookings whose check-out falls within the reminder window
 * and send reminders to tenant + host if not already sent.
 */
async function processCheckOutReminders(
  leadHours: number,
  result: ReminderResult,
): Promise<void> {
  const now       = new Date();
  const windowEnd = new Date(now.getTime() + leadHours * 3_600_000);

  const { data: bookings, error } = await supabase
    .from('bookings')
    .select(
      `id, tenant_id, check_in, check_out, total_price, guest_count,
       properties ( title, owner_id )`,
    )
    .gte('check_out', now.toISOString().slice(0, 10))
    .lte('check_out', windowEnd.toISOString().slice(0, 10))
    .not('status', 'eq', 'Cancelled');

  if (error || !bookings) return;

  for (const booking of bookings as Array<{
    id: string; tenant_id: string; check_in: string; check_out: string;
    total_price: number; guest_count: number;
    properties: { title: string; owner_id: string } | null;
  }>) {
    const propertyTitle = booking.properties?.title ?? 'your rental';
    const ownerId       = booking.properties?.owner_id;

    const notifData = {
      propertyTitle,
      checkIn:    booking.check_in,
      checkOut:   booking.check_out,
      totalPrice: booking.total_price,
      guestCount: booking.guest_count,
    };

    // Tenant reminder
    try {
      const alreadySent = !(await markReminderSent(booking.id, 'checkout_tenant'));
      if (alreadySent) {
        result.skipped++;
      } else {
        const sent = await sendReminderIfAllowed(booking.tenant_id, booking.id, {
          ...notifData, role: 'tenant', event: 'check_out',
        });
        sent ? result.sent++ : result.skipped++;
      }
    } catch {
      result.errors++;
    }

    // Host reminder
    if (ownerId) {
      try {
        const alreadySent = !(await markReminderSent(booking.id, 'checkout_host'));
        if (alreadySent) {
          result.skipped++;
        } else {
          const sent = await sendReminderIfAllowed(ownerId, booking.id, {
            ...notifData, role: 'host', event: 'check_out',
          });
          sent ? result.sent++ : result.skipped++;
        }
      } catch {
        result.errors++;
      }
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run one pass of the reminder scheduler.
 * Designed to be called on a timer (e.g. every hour).
 */
export async function runReminderScheduler(): Promise<ServiceResponse<ReminderResult>> {
  const { checkIn: checkInHours, checkOut: checkOutHours } = getLeadTimeHours();
  const result: ReminderResult = { sent: 0, skipped: 0, errors: 0 };

  await processCheckInReminders(checkInHours, result);
  await processCheckOutReminders(checkOutHours, result);

  return { success: true, data: result };
}
