'use client';

import { useEffect, useState, useCallback } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

export interface MonthlyEarnings {
  month: string;
  label: string;
  earnings: number;
  bookings: number;
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

export interface HostAnalytics {
  totalEarnings: number;
  earningsThisMonth: number;
  earningsLastMonth: number;
  earningsMoMGrowth: number;
  earningsYoYGrowth: number;
  totalBookings: number;
  activeBookings: number;
  completedBookings: number;
  cancelledBookings: number;
  pendingBookings: number;
  bookingCompletionRate: number;
  occupancyRateThisMonth: number;
  occupancyRateLastMonth: number;
  averageNightlyRate: number;
  averageRating: number;
  totalReviews: number;
  pendingPayout: number;
  totalPayouts: number;
  monthlyEarnings: MonthlyEarnings[];
  bookingTrends: MonthlyEarnings[];
  propertyPerformance: PropertyPerformance[];
}

export function useHostAnalytics() {
  const [data, setData] = useState<HostAnalytics | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAnalytics = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    const token = localStorage.getItem('token');
    if (!token) {
      setError('Not authenticated');
      setIsLoading(false);
      return;
    }
    try {
      const res = await fetch(`${API_URL}/api/analytics/host`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Failed to load analytics (${res.status})`);
      const json = await res.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load analytics');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAnalytics();
  }, [fetchAnalytics]);

  const exportCSV = useCallback(async () => {
    const token = localStorage.getItem('token');
    if (!token) return;
    const res = await fetch(`${API_URL}/api/analytics/host/export?format=csv`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'host-earnings.csv';
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  return { data, isLoading, error, refetch: fetchAnalytics, exportCSV };
}
