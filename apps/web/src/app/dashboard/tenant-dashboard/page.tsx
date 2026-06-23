'use client';

import { useState } from 'react';
import {
  DollarSign,
  TrendingUp,
  Calendar,
  CheckCircle,
  XCircle,
  Clock,
  Moon,
  MapPin,
  Download,
  RefreshCw,
} from 'lucide-react';
import { useTenantAnalytics } from '@/hooks/useTenantAnalytics';
import { useDashboard } from '@/hooks/useDashboard';
import StatCard from '@/components/analytics/StatCard';
import SpendingChart from '@/components/analytics/SpendingChart';
import BookingTrendsChart from '@/components/analytics/BookingTrendsChart';
import UpcomingTrips from '@/components/analytics/UpcomingTrips';
import FavoriteLocations from '@/components/analytics/FavoriteLocations';
import BookingHistory from '@/components/dashboard/BookingHistory';
import NotificationSystem from '@/components/dashboard/NotificationSystem';
import WalletTransaction from './components/WalletTransaction';

type TabKey = 'overview' | 'bookings' | 'spending';

export default function TenantDashboard() {
  const [activeTab, setActiveTab] = useState<TabKey>('overview');

  const {
    data,
    isLoading: analyticsLoading,
    error: analyticsError,
    refetch,
    exportCSV,
  } = useTenantAnalytics();

  const { bookings, isLoading: bookingsLoading, error: bookingsError } = useDashboard();

  const formattedBookings = bookings.map((booking) => ({
    id: booking.id,
    propertyTitle: 'Property',
    location: 'Location',
    checkIn: new Date(booking.check_in),
    checkOut: new Date(booking.check_out),
    totalPrice: booking.total_price,
    status: booking.status as 'pending' | 'confirmed' | 'completed' | 'cancelled',
    escrowStatus: booking.escrow_status as 'locked' | 'released' | 'refunded',
  }));

  const mockTransactions = [
    {
      id: '1',
      type: 'sent' as const,
      amount: 600,
      date: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      description: 'Booking payment — Downtown Apartment',
    },
    {
      id: '2',
      type: 'received' as const,
      amount: 100,
      date: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
      description: 'Refund — Cancelled booking',
    },
  ];

  const tabs: { key: TabKey; label: string }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'bookings', label: 'Bookings' },
    { key: 'spending', label: 'Spending' },
  ];

  const isLoading = analyticsLoading || bookingsLoading;

  return (
    <main className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-7xl mx-auto px-4 space-y-6">

        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Tenant Dashboard</h1>
            <p className="text-sm text-gray-500 mt-0.5">Track your bookings and travel spending</p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={refetch}
              className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 border border-gray-200 bg-white rounded-lg px-3 py-2 transition"
              aria-label="Refresh dashboard"
            >
              <RefreshCw size={15} />
              Refresh
            </button>
            <button
              onClick={exportCSV}
              className="flex items-center gap-1.5 text-sm text-gray-700 border border-gray-200 bg-white rounded-lg px-3 py-2 hover:bg-gray-50 transition"
              aria-label="Export bookings as CSV"
            >
              <Download size={15} />
              Export CSV
            </button>
            <NotificationSystem />
          </div>
        </div>

        {/* Errors */}
        {(analyticsError || bookingsError) && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700" role="alert">
            {analyticsError || bookingsError}
          </div>
        )}

        {/* Loading skeletons */}
        {isLoading && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="bg-white rounded-xl border border-gray-100 h-28 animate-pulse" />
            ))}
          </div>
        )}

        {!isLoading && (
          <>
            {/* Tabs */}
            <div className="flex gap-1 bg-gray-100 p-1 rounded-lg w-fit">
              {tabs.map(t => (
                <button
                  key={t.key}
                  onClick={() => setActiveTab(t.key)}
                  className={`px-4 py-1.5 rounded-md text-sm font-medium transition ${
                    activeTab === t.key
                      ? 'bg-white text-gray-900 shadow-sm'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {/* ── Overview Tab ── */}
            {activeTab === 'overview' && (
              <div className="space-y-6">

                {/* KPI Cards */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <StatCard
                    title="Total Spent"
                    value={`${(data?.totalSpent ?? 0).toFixed(0)} USDC`}
                    icon={DollarSign}
                    iconColor="text-purple-600"
                    variant="gradient"
                    gradientFrom="from-purple-50"
                    gradientTo="to-purple-100"
                  />
                  <StatCard
                    title="This Month"
                    value={`${(data?.spentThisMonth ?? 0).toFixed(0)} USDC`}
                    growth={data?.spentMoMGrowth}
                    icon={TrendingUp}
                    iconColor="text-blue-600"
                    variant="gradient"
                    gradientFrom="from-blue-50"
                    gradientTo="to-blue-100"
                  />
                  <StatCard
                    title="Upcoming Trips"
                    value={data?.upcomingBookings ?? 0}
                    icon={Calendar}
                    iconColor="text-cyan-600"
                  />
                  <StatCard
                    title="Avg Stay"
                    value={`${data?.averageStayDuration ?? 0} nights`}
                    icon={Moon}
                    iconColor="text-indigo-600"
                  />
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <StatCard
                    title="Total Bookings"
                    value={data?.totalBookings ?? 0}
                    icon={Calendar}
                    iconColor="text-gray-600"
                  />
                  <StatCard
                    title="Completed"
                    value={data?.completedBookings ?? 0}
                    icon={CheckCircle}
                    iconColor="text-emerald-600"
                  />
                  <StatCard
                    title="Cancelled"
                    value={data?.cancelledBookings ?? 0}
                    icon={XCircle}
                    iconColor="text-red-500"
                  />
                  <StatCard
                    title="Avg Spend / Trip"
                    value={`${(data?.averageSpendPerTrip ?? 0).toFixed(0)} USDC`}
                    icon={MapPin}
                    iconColor="text-orange-500"
                  />
                </div>

                {/* Charts row */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
                  <div className="lg:col-span-2">
                    <SpendingChart
                      data={data?.monthlySpending ?? []}
                      title="Monthly Spending — Last 6 Months"
                    />
                  </div>
                  <FavoriteLocations locations={data?.favoriteLocations ?? []} />
                </div>

                {/* Upcoming trips + wallet */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                  <UpcomingTrips trips={data?.upcomingTrips ?? []} />
                  <WalletTransaction transactions={mockTransactions} />
                </div>
              </div>
            )}

            {/* ── Bookings Tab ── */}
            {activeTab === 'bookings' && (
              <div className="space-y-6">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <StatCard title="Total" value={data?.totalBookings ?? 0} icon={Calendar} iconColor="text-gray-600" />
                  <StatCard title="Active" value={data?.activeBookings ?? 0} icon={Clock} iconColor="text-amber-500" />
                  <StatCard title="Completed" value={data?.completedBookings ?? 0} icon={CheckCircle} iconColor="text-emerald-600" />
                  <StatCard title="Cancelled" value={data?.cancelledBookings ?? 0} icon={XCircle} iconColor="text-red-500" />
                </div>

                <BookingTrendsChart
                  data={(data?.monthlySpending ?? []).map(d => ({
                    label: d.label,
                    bookings: d.bookings,
                    month: d.month,
                  }))}
                  title="Booking Activity — Last 6 Months"
                />

                <div>
                  <h2 className="text-lg font-semibold text-gray-900 mb-4">All Bookings</h2>
                  <BookingHistory bookings={formattedBookings} />
                </div>
              </div>
            )}

            {/* ── Spending Tab ── */}
            {activeTab === 'spending' && (
              <div className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <StatCard
                    title="Total Spent"
                    value={`${(data?.totalSpent ?? 0).toFixed(2)} USDC`}
                    icon={DollarSign}
                    variant="gradient"
                    gradientFrom="from-purple-50"
                    gradientTo="to-purple-100"
                    iconColor="text-purple-600"
                  />
                  <StatCard
                    title="MoM Growth"
                    value={`${data?.spentMoMGrowth ?? 0}%`}
                    subtitle="vs last month"
                    growth={data?.spentMoMGrowth}
                    icon={TrendingUp}
                    iconColor="text-blue-600"
                  />
                  <StatCard
                    title="Avg Spend / Trip"
                    value={`${(data?.averageSpendPerTrip ?? 0).toFixed(2)} USDC`}
                    icon={MapPin}
                    iconColor="text-orange-500"
                  />
                </div>

                <SpendingChart
                  data={data?.monthlySpending ?? []}
                  title="Spending — Last 12 Months"
                />

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                  <FavoriteLocations locations={data?.favoriteLocations ?? []} />
                  <WalletTransaction transactions={mockTransactions} />
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}
