/**
 * Analytics Service
 * Aggregates earnings, booking stats, occupancy rates, and trends
 * for host and tenant dashboards.
 */

import { supabase } from '@/config/supabase.js';
import type { ServiceResponse } from './index.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface MonthlyEarnings {
  month: string;       // e.g. "2025-01"
  label: string;       // e.g. "Jan 2025"
  earnings: number;
  bookings: number;
}

export interface HostAnalytics {
  // Summary cards
  totalEarnings: number;
  earningsThisMonth: number;
  earningsLastMonth: number;
  earningsMoMGrowth: number;   // percentage
  earningsYoYGrowth: number;   // percentage

  // Booking stats
  totalBookings: number;
  activeBookings: number;
  completedBookings: number;
  cancelledBookings: number;
  pendingBookings: number;
  bookingCompletionRate: number; // percentage

  // Occupancy
  occupancyRateThisMonth: number;  // percentage 0-100
  occupancyRateLastMonth: number;
  averageNightlyRate: number;

  // Rating
  averageRating: number;
  totalReviews: number;

  // Payout
  pendingPayout: number;
  totalPayouts: number;

  // Time-series
  monthlyEarnings: MonthlyEarnings[];   // last 12 months
  bookingTrends: MonthlyEarnings[];     // last 12 months

  // Per-property breakdown
  propertyPerformance: PropertyPerformance[];
}

export interface PropertyPerformance {
  property_id: string;
  title: string;
  location: string;
  price_per_night: number;
  totalEarnings: number;
  totalBookings: number;
  completedBookings: number;
  occupancyRate: number;
  averageRating: number;
  totalReviews: number;
}

export interface TenantBookingStat {
  month: string;
  label: string;
  spent: number;
  bookings: number;
}

export interface TenantAnalytics {
  // Summary
  totalSpent: number;
  spentThisMonth: number;
  spentLastMonth: number;
  spentMoMGrowth: number;

  // Bookings
  totalBookings: number;
  completedBookings: number;
  cancelledBookings: number;
  upcomingBookings: number;
  activeBookings: number;

  // Preferences
  averageStayDuration: number;   // nights
  averageSpendPerTrip: number;
  favoriteLocations: { location: string; count: number }[];

  // Time-series (last 12 months)
  monthlySpending: TenantBookingStat[];

  // Upcoming
  upcomingTrips: UpcomingTrip[];
}

export interface UpcomingTrip {
  id: string;
  property_title: string;
  location: string;
  check_in: string;
  check_out: string;
  total_price: number;
  status: string;
  nights: number;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function buildLast12Months(): { key: string; label: string }[] {
  const months: { key: string; label: string }[] = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const label = `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
    months.push({ key, label });
  }
  return months;
}

function calcGrowth(current: number, previous: number): number {
  if (previous === 0) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

// ─── Service ───────────────────────────────────────────────────────────────

export class AnalyticsService {

  // ── Host Analytics ───────────────────────────────────────────────────────

  async getHostAnalytics(hostId: string): Promise<ServiceResponse<HostAnalytics>> {
    if (!hostId) return { success: false, error: 'Host ID is required' };

    try {
      // Fetch all properties owned by host
      const { data: properties, error: propErr } = await supabase
        .from('properties')
        .select('id, title, location, price_per_night')
        .eq('owner_id', hostId);

      if (propErr) return { success: false, error: propErr.message };

      const props = (properties ?? []) as {
        id: string; title: string; location: string; price_per_night: number;
      }[];

      if (props.length === 0) {
        return { success: true, data: this.emptyHostAnalytics() };
      }

      const propertyIds = props.map(p => p.id);

      // Fetch all bookings for these properties
      const { data: bookingsRaw, error: bookErr } = await supabase
        .from('bookings')
        .select('id, property_id, check_in, check_out, total_price, status, created_at')
        .in('property_id', propertyIds);

      if (bookErr) return { success: false, error: bookErr.message };

      const bookings = (bookingsRaw ?? []) as {
        id: string; property_id: string; check_in: string; check_out: string;
        total_price: number; status: string; created_at: string;
      }[];

      // Fetch reviews for host properties
      const { data: reviewsRaw } = await supabase
        .from('reviews')
        .select('property_id, rating')
        .in('property_id', propertyIds);

      const reviews = (reviewsRaw ?? []) as { property_id: string; rating: number }[];

      // ── Computed values ──
      const now = new Date();
      const thisMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const lastMonthKey = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth() + 1).padStart(2, '0')}`;
      const lastYearSameMonthKey = `${now.getFullYear() - 1}-${String(now.getMonth() + 1).padStart(2, '0')}`;

      const completedBookings = bookings.filter(b =>
        b.status === 'Confirmed' || b.status === 'confirmed' ||
        b.status === 'completed' || b.status === 'Completed'
      );
      const cancelledBookings = bookings.filter(b =>
        b.status === 'Cancelled' || b.status === 'cancelled'
      );
      const activeBookings = bookings.filter(b =>
        (b.status === 'Pending' || b.status === 'pending') &&
        new Date(b.check_out) >= now
      );
      const pendingBookings = bookings.filter(b =>
        b.status === 'Pending' || b.status === 'pending'
      );

      const totalEarnings = completedBookings.reduce((sum, b) => sum + (b.total_price || 0), 0);

      const earningsThisMonth = completedBookings
        .filter(b => (b.created_at || '').startsWith(thisMonthKey))
        .reduce((sum, b) => sum + (b.total_price || 0), 0);

      const earningsLastMonth = completedBookings
        .filter(b => (b.created_at || '').startsWith(lastMonthKey))
        .reduce((sum, b) => sum + (b.total_price || 0), 0);

      const earningsLastYearSameMonth = completedBookings
        .filter(b => (b.created_at || '').startsWith(lastYearSameMonthKey))
        .reduce((sum, b) => sum + (b.total_price || 0), 0);

      // Monthly time-series (last 12 months)
      const last12 = buildLast12Months();
      const monthlyEarnings: MonthlyEarnings[] = last12.map(({ key, label }) => {
        const monthCompleted = completedBookings.filter(b =>
          (b.created_at || '').startsWith(key)
        );
        return {
          month: key,
          label,
          earnings: monthCompleted.reduce((s, b) => s + (b.total_price || 0), 0),
          bookings: monthCompleted.length,
        };
      });

      const bookingTrends: MonthlyEarnings[] = last12.map(({ key, label }) => {
        const monthAll = bookings.filter(b => (b.created_at || '').startsWith(key));
        const monthCompleted = monthAll.filter(b =>
          b.status === 'Confirmed' || b.status === 'confirmed' ||
          b.status === 'completed' || b.status === 'Completed'
        );
        return {
          month: key,
          label,
          earnings: monthCompleted.reduce((s, b) => s + (b.total_price || 0), 0),
          bookings: monthAll.length,
        };
      });

      // Occupancy rate — nights booked / total nights in month
      const daysInThisMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const daysInLastMonth = new Date(lastMonthDate.getFullYear(), lastMonthDate.getMonth() + 1, 0).getDate();
      const totalPropertyDaysThisMonth = props.length * daysInThisMonth;
      const totalPropertyDaysLastMonth = props.length * daysInLastMonth;

      const bookedNightsThisMonth = bookings
        .filter(b => {
          const ci = new Date(b.check_in);
          return ci.getFullYear() === now.getFullYear() && ci.getMonth() === now.getMonth();
        })
        .reduce((sum, b) => {
          const nights = Math.ceil(
            (new Date(b.check_out).getTime() - new Date(b.check_in).getTime()) / 86400000
          );
          return sum + Math.max(nights, 0);
        }, 0);

      const bookedNightsLastMonth = bookings
        .filter(b => {
          const ci = new Date(b.check_in);
          return ci.getFullYear() === lastMonthDate.getFullYear() &&
            ci.getMonth() === lastMonthDate.getMonth();
        })
        .reduce((sum, b) => {
          const nights = Math.ceil(
            (new Date(b.check_out).getTime() - new Date(b.check_in).getTime()) / 86400000
          );
          return sum + Math.max(nights, 0);
        }, 0);

      const occupancyRateThisMonth = totalPropertyDaysThisMonth > 0
        ? Math.min(100, Math.round((bookedNightsThisMonth / totalPropertyDaysThisMonth) * 100))
        : 0;
      const occupancyRateLastMonth = totalPropertyDaysLastMonth > 0
        ? Math.min(100, Math.round((bookedNightsLastMonth / totalPropertyDaysLastMonth) * 100))
        : 0;

      const avgRating = reviews.length > 0
        ? Math.round((reviews.reduce((s, r) => s + r.rating, 0) / reviews.length) * 10) / 10
        : 0;

      const avgNightlyRate = props.length > 0
        ? Math.round(props.reduce((s, p) => s + p.price_per_night, 0) / props.length)
        : 0;

      // Per-property breakdown
      const propertyPerformance: PropertyPerformance[] = props.map(p => {
        const pb = bookings.filter(b => b.property_id === p.id);
        const pc = pb.filter(b =>
          b.status === 'Confirmed' || b.status === 'confirmed' ||
          b.status === 'completed' || b.status === 'Completed'
        );
        const pr = reviews.filter(r => r.property_id === p.id);
        const propEarnings = pc.reduce((s, b) => s + (b.total_price || 0), 0);
        const propBookedNights = pb.reduce((sum, b) => {
          const nights = Math.ceil(
            (new Date(b.check_out).getTime() - new Date(b.check_in).getTime()) / 86400000
          );
          return sum + Math.max(nights, 0);
        }, 0);
        const propOccupancy = totalPropertyDaysThisMonth > 0
          ? Math.min(100, Math.round((propBookedNights / (daysInThisMonth)) * 100))
          : 0;
        const propAvgRating = pr.length > 0
          ? Math.round((pr.reduce((s, r) => s + r.rating, 0) / pr.length) * 10) / 10
          : 0;

        return {
          property_id: p.id,
          title: p.title,
          location: p.location || '',
          price_per_night: p.price_per_night,
          totalEarnings: Math.round(propEarnings * 100) / 100,
          totalBookings: pb.length,
          completedBookings: pc.length,
          occupancyRate: propOccupancy,
          averageRating: propAvgRating,
          totalReviews: pr.length,
        };
      });

      const completionRate = bookings.length > 0
        ? Math.round((completedBookings.length / bookings.length) * 100)
        : 0;

      const analytics: HostAnalytics = {
        totalEarnings: Math.round(totalEarnings * 100) / 100,
        earningsThisMonth: Math.round(earningsThisMonth * 100) / 100,
        earningsLastMonth: Math.round(earningsLastMonth * 100) / 100,
        earningsMoMGrowth: calcGrowth(earningsThisMonth, earningsLastMonth),
        earningsYoYGrowth: calcGrowth(earningsThisMonth, earningsLastYearSameMonth),
        totalBookings: bookings.length,
        activeBookings: activeBookings.length,
        completedBookings: completedBookings.length,
        cancelledBookings: cancelledBookings.length,
        pendingBookings: pendingBookings.length,
        bookingCompletionRate: completionRate,
        occupancyRateThisMonth,
        occupancyRateLastMonth,
        averageNightlyRate: avgNightlyRate,
        averageRating: avgRating,
        totalReviews: reviews.length,
        pendingPayout: Math.round(earningsThisMonth * 100) / 100,
        totalPayouts: Math.round((totalEarnings - earningsThisMonth) * 100) / 100,
        monthlyEarnings,
        bookingTrends,
        propertyPerformance,
      };

      return { success: true, data: analytics };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  // ── Tenant Analytics ─────────────────────────────────────────────────────

  async getTenantAnalytics(tenantId: string): Promise<ServiceResponse<TenantAnalytics>> {
    if (!tenantId) return { success: false, error: 'Tenant ID is required' };

    try {
      const { data: bookingsRaw, error: bookErr } = await supabase
        .from('bookings')
        .select(`
          id, property_id, check_in, check_out, total_price, status, created_at,
          properties(title, location)
        `)
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false });

      if (bookErr) return { success: false, error: bookErr.message };

      const bookings = (bookingsRaw ?? []) as {
        id: string; property_id: string; check_in: string; check_out: string;
        total_price: number; status: string; created_at: string;
        properties?: { title: string; location: string } | null;
      }[];

      const now = new Date();
      const thisMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const lastMonthKey = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth() + 1).padStart(2, '0')}`;

      const completedBookings = bookings.filter(b =>
        b.status === 'Confirmed' || b.status === 'confirmed' ||
        b.status === 'completed' || b.status === 'Completed'
      );
      const cancelledBookings = bookings.filter(b =>
        b.status === 'Cancelled' || b.status === 'cancelled'
      );
      const upcomingBookings = bookings.filter(b =>
        new Date(b.check_in) > now &&
        b.status !== 'Cancelled' && b.status !== 'cancelled'
      );
      const activeBookings = bookings.filter(b =>
        new Date(b.check_in) <= now && new Date(b.check_out) >= now &&
        b.status !== 'Cancelled' && b.status !== 'cancelled'
      );

      const totalSpent = completedBookings.reduce((s, b) => s + (b.total_price || 0), 0);
      const spentThisMonth = completedBookings
        .filter(b => (b.created_at || '').startsWith(thisMonthKey))
        .reduce((s, b) => s + (b.total_price || 0), 0);
      const spentLastMonth = completedBookings
        .filter(b => (b.created_at || '').startsWith(lastMonthKey))
        .reduce((s, b) => s + (b.total_price || 0), 0);

      // Average stay duration
      const stayDurations = completedBookings.map(b => {
        const nights = Math.ceil(
          (new Date(b.check_out).getTime() - new Date(b.check_in).getTime()) / 86400000
        );
        return Math.max(nights, 0);
      });
      const averageStayDuration = stayDurations.length > 0
        ? Math.round((stayDurations.reduce((s, n) => s + n, 0) / stayDurations.length) * 10) / 10
        : 0;

      const averageSpendPerTrip = completedBookings.length > 0
        ? Math.round((totalSpent / completedBookings.length) * 100) / 100
        : 0;

      // Favorite locations
      const locationCounts: Record<string, number> = {};
      bookings.forEach(b => {
        const loc = b.properties?.location || 'Unknown';
        locationCounts[loc] = (locationCounts[loc] || 0) + 1;
      });
      const favoriteLocations = Object.entries(locationCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([location, count]) => ({ location, count }));

      // Monthly spending (last 12 months)
      const last12 = buildLast12Months();
      const monthlySpending: TenantBookingStat[] = last12.map(({ key, label }) => {
        const monthBookings = bookings.filter(b => (b.created_at || '').startsWith(key));
        const monthCompleted = monthBookings.filter(b =>
          b.status === 'Confirmed' || b.status === 'confirmed' ||
          b.status === 'completed' || b.status === 'Completed'
        );
        return {
          month: key,
          label,
          spent: monthCompleted.reduce((s, b) => s + (b.total_price || 0), 0),
          bookings: monthBookings.length,
        };
      });

      // Upcoming trips
      const upcomingTrips: UpcomingTrip[] = upcomingBookings.slice(0, 5).map(b => {
        const nights = Math.ceil(
          (new Date(b.check_out).getTime() - new Date(b.check_in).getTime()) / 86400000
        );
        return {
          id: b.id,
          property_title: b.properties?.title || 'Property',
          location: b.properties?.location || 'Unknown',
          check_in: b.check_in,
          check_out: b.check_out,
          total_price: b.total_price,
          status: b.status,
          nights: Math.max(nights, 0),
        };
      });

      const analytics: TenantAnalytics = {
        totalSpent: Math.round(totalSpent * 100) / 100,
        spentThisMonth: Math.round(spentThisMonth * 100) / 100,
        spentLastMonth: Math.round(spentLastMonth * 100) / 100,
        spentMoMGrowth: calcGrowth(spentThisMonth, spentLastMonth),
        totalBookings: bookings.length,
        completedBookings: completedBookings.length,
        cancelledBookings: cancelledBookings.length,
        upcomingBookings: upcomingBookings.length,
        activeBookings: activeBookings.length,
        averageStayDuration,
        averageSpendPerTrip,
        favoriteLocations,
        monthlySpending,
        upcomingTrips,
      };

      return { success: true, data: analytics };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  // ── Export helpers ────────────────────────────────────────────────────────

  async getHostEarningsExport(hostId: string): Promise<ServiceResponse<object[]>> {
    if (!hostId) return { success: false, error: 'Host ID is required' };

    try {
      const { data: properties } = await supabase
        .from('properties')
        .select('id')
        .eq('owner_id', hostId);

      const propertyIds = (properties ?? []).map((p: { id: string }) => p.id);
      if (propertyIds.length === 0) return { success: true, data: [] };

      const { data: bookings, error } = await supabase
        .from('bookings')
        .select(`id, check_in, check_out, total_price, status, created_at, properties(title, location)`)
        .in('property_id', propertyIds)
        .order('created_at', { ascending: false });

      if (error) return { success: false, error: error.message };

      const rows = (bookings ?? []).map((b: {
        id: string; check_in: string; check_out: string; total_price: number;
        status: string; created_at: string;
        properties?: { title: string; location: string } | null;
      }) => ({
        booking_id: b.id,
        property: b.properties?.title || '',
        location: b.properties?.location || '',
        check_in: b.check_in,
        check_out: b.check_out,
        total_price_usdc: b.total_price,
        status: b.status,
        date: b.created_at,
      }));

      return { success: true, data: rows };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  async getTenantBookingsExport(tenantId: string): Promise<ServiceResponse<object[]>> {
    if (!tenantId) return { success: false, error: 'Tenant ID is required' };

    try {
      const { data: bookings, error } = await supabase
        .from('bookings')
        .select(`id, check_in, check_out, total_price, status, created_at, properties(title, location)`)
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false });

      if (error) return { success: false, error: error.message };

      const rows = (bookings ?? []).map((b: {
        id: string; check_in: string; check_out: string; total_price: number;
        status: string; created_at: string;
        properties?: { title: string; location: string } | null;
      }) => ({
        booking_id: b.id,
        property: b.properties?.title || '',
        location: b.properties?.location || '',
        check_in: b.check_in,
        check_out: b.check_out,
        total_price_usdc: b.total_price,
        status: b.status,
        date: b.created_at,
      }));

      return { success: true, data: rows };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  // ── Empty state ───────────────────────────────────────────────────────────

  private emptyHostAnalytics(): HostAnalytics {
    const last12 = buildLast12Months();
    return {
      totalEarnings: 0, earningsThisMonth: 0, earningsLastMonth: 0,
      earningsMoMGrowth: 0, earningsYoYGrowth: 0,
      totalBookings: 0, activeBookings: 0, completedBookings: 0,
      cancelledBookings: 0, pendingBookings: 0, bookingCompletionRate: 0,
      occupancyRateThisMonth: 0, occupancyRateLastMonth: 0, averageNightlyRate: 0,
      averageRating: 0, totalReviews: 0, pendingPayout: 0, totalPayouts: 0,
      monthlyEarnings: last12.map(m => ({ ...m, earnings: 0, bookings: 0 })),
      bookingTrends: last12.map(m => ({ ...m, earnings: 0, bookings: 0 })),
      propertyPerformance: [],
    };
  }
}
