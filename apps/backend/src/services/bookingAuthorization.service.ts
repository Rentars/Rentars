/**
 * Booking Authorization Service
 *
 * Centralizes role-based authorization checks for booking operations.
 * Enforces the principle of least privilege:
 *
 *   - Tenant can: cancel own booking, complete own booking, dispute, request modifications
 *   - Host can: confirm bookings on their properties, accept/decline modifications
 *   - Moderator/Admin can: resolve disputes, read all bookings, manage properties
 *   - Support can: read-only access to bookings and disputes
 */

import { supabase } from '@/config/supabase.js';
import type { AdminRole } from '@/config/adminScopes.js';

export class BookingAuthorizationService {
  /**
   * Check if user is the tenant of a booking.
   */
  async isTenant(bookingId: string, userId: string): Promise<boolean> {
    const { data, error } = await supabase
      .from('bookings')
      .select('tenant_id')
      .eq('id', bookingId)
      .single();

    if (error || !data) return false;
    return data.tenant_id === userId;
  }

  /**
   * Check if user is the host (property owner) of a booking.
   */
  async isHost(bookingId: string, userId: string): Promise<boolean> {
    const { data, error } = await supabase
      .from('bookings')
      .select('properties!inner(owner_id)')
      .eq('id', bookingId)
      .single();

    if (error || !data) return false;
    const booking = data as unknown as { properties: { owner_id: string } };
    return booking.properties.owner_id === userId;
  }

  /**
   * Check if user can cancel a booking.
   * Only the tenant can cancel (unless it's an admin with cancel scope).
   */
  async canCancel(bookingId: string, userId: string, userRole?: string): Promise<{
    allowed: boolean;
    reason?: string;
  }> {
    // Admins can always cancel
    if (userRole === 'admin' || userRole === 'moderator') {
      return { allowed: true };
    }

    const isTenant = await this.isTenant(bookingId, userId);
    if (!isTenant) {
      return {
        allowed: false,
        reason: 'Forbidden: Only the tenant may cancel a booking',
      };
    }

    return { allowed: true };
  }

  /**
   * Check if user can confirm a booking.
   * Only the host (property owner) can confirm, or an admin.
   */
  async canConfirm(bookingId: string, userId: string, userRole?: string): Promise<{
    allowed: boolean;
    reason?: string;
  }> {
    // Admins can always confirm
    if (userRole === 'admin' || userRole === 'moderator') {
      return { allowed: true };
    }

    const isHost = await this.isHost(bookingId, userId);
    if (!isHost) {
      return {
        allowed: false,
        reason: 'Forbidden: Only the host may confirm a booking',
      };
    }

    return { allowed: true };
  }

  /**
   * Check if user can complete a booking.
   * Only the tenant can mark as complete (after host has confirmed).
   */
  async canComplete(bookingId: string, userId: string, userRole?: string): Promise<{
    allowed: boolean;
    reason?: string;
  }> {
    // Admins can always complete
    if (userRole === 'admin' || userRole === 'moderator') {
      return { allowed: true };
    }

    const isTenant = await this.isTenant(bookingId, userId);
    if (!isTenant) {
      return {
        allowed: false,
        reason: 'Forbidden: Only the tenant may complete a booking',
      };
    }

    return { allowed: true };
  }

  /**
   * Check if user can dispute a booking.
   * Only the tenant or host can dispute.
   */
  async canDispute(bookingId: string, userId: string, userRole?: string): Promise<{
    allowed: boolean;
    reason?: string;
  }> {
    // Admins can always dispute
    if (userRole === 'admin' || userRole === 'moderator') {
      return { allowed: true };
    }

    const [isTenant, isHost] = await Promise.all([
      this.isTenant(bookingId, userId),
      this.isHost(bookingId, userId),
    ]);

    if (!isTenant && !isHost) {
      return {
        allowed: false,
        reason: 'Forbidden: Only the tenant or host may dispute a booking',
      };
    }

    return { allowed: true };
  }

  /**
   * Check if user can request a modification (date change).
   * Only the tenant can request modifications.
   */
  async canRequestModification(bookingId: string, userId: string, userRole?: string): Promise<{
    allowed: boolean;
    reason?: string;
  }> {
    // Admins can always request modifications
    if (userRole === 'admin' || userRole === 'moderator') {
      return { allowed: true };
    }

    const isTenant = await this.isTenant(bookingId, userId);
    if (!isTenant) {
      return {
        allowed: false,
        reason: 'Forbidden: Only the tenant may request a modification',
      };
    }

    return { allowed: true };
  }

  /**
   * Check if user can accept or decline a modification.
   * Only the host can accept/decline modifications on their bookings.
   */
  async canManageModification(bookingId: string, userId: string, userRole?: string): Promise<{
    allowed: boolean;
    reason?: string;
  }> {
    // Admins can always manage modifications
    if (userRole === 'admin' || userRole === 'moderator') {
      return { allowed: true };
    }

    const isHost = await this.isHost(bookingId, userId);
    if (!isHost) {
      return {
        allowed: false,
        reason: 'Forbidden: Only the host may accept or decline modifications',
      };
    }

    return { allowed: true };
  }

  /**
   * Check if user can read a booking.
   * Tenant/Host can read their own. Support/Admins can read all.
   */
  async canRead(bookingId: string, userId: string, userRole?: string): Promise<{
    allowed: boolean;
    reason?: string;
  }> {
    // Admins, moderators, support, and finance can read all bookings
    if (userRole === 'admin' || userRole === 'moderator' || userRole === 'support' || userRole === 'finance') {
      return { allowed: true };
    }

    // Regular users can read their own bookings
    const [isTenant, isHost] = await Promise.all([
      this.isTenant(bookingId, userId),
      this.isHost(bookingId, userId),
    ]);

    if (!isTenant && !isHost) {
      return {
        allowed: false,
        reason: 'Forbidden: You do not have access to this booking',
      };
    }

    return { allowed: true };
  }
}

export const bookingAuthorizationService = new BookingAuthorizationService();
