'use client';

import { useEffect, useState, useCallback } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

export interface TenantBookingStat {
  month: string;
  label: string;
  spent: number;
  bookings: number;
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

export interface TenantAnalytics {
  totalSpent: number;
  spentThisMonth: number;
  spentLastMonth: number;
  spentMoMGrowth: number;
  totalBookings: number;
  completedBookings: number;
  cancelledBookings: number;
  upcomingBookings: number;
  activeBookings: number;
  averageStayDuration: number;
  averageSpendPerTrip: number;
  favoriteLocations: { location: string; count: number }[];
  monthlySpending: TenantBookingStat[];
  upcomingTrips: UpcomingTrip[];
}

export function useTenantAnalytics() {
  const [data, setData] = useState<TenantAnalytics | null>(null);
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
      const res = await fetch(`${API_URL}/api/analytics/tenant`, {
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
    const res = await fetch(`${API_URL}/api/analytics/tenant/export?format=csv`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'tenant-bookings.csv';
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  return { data, isLoading, error, refetch: fetchAnalytics, exportCSV };
}
