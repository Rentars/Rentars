'use client';

import { useState } from 'react';
import {
  Plus,
  Download,
  RefreshCw,
  DollarSign,
  TrendingUp,
  Home,
  Star,
  Calendar,
  CheckCircle,
  XCircle,
  Clock,
  Wallet,
} from 'lucide-react';
import { useHostAnalytics } from '@/hooks/useHostAnalytics';
import StatCard from '@/components/analytics/StatCard';
import EarningsChart from '@/components/analytics/EarningsChart';
import BookingTrendsChart from '@/components/analytics/BookingTrendsChart';
import OccupancyGauge from '@/components/analytics/OccupancyGauge';
import PropertyPerformanceTable from '@/components/analytics/PropertyPerformanceTable';
import AddPropertyModal from './components/AddPropertyModal';
import PayoutHistory from './components/PayoutHistory';
import RecentTransactions from './components/RecentTransactions';
import { mockHostData } from './mockData';

type TabKey = 'overview' | 'earnings' | 'properties';

export default function HostDashboard() {
  const [showAddProperty, setShowAddProperty] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>('overview');
  const { data, isLoading, error, refetch, exportCSV } = useHostAnalytics();

  const handleAddProperty = (formData: {
    title: string;
    location: string;
    pricePerNight: number;
    description: string;
  }) => {
    console.log('Adding property:', formData);
    setShowAddProperty(false);
  };

  const tabs: { key: TabKey; label: string }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'earnings', label: 'Earnings' },
    { key: 'properties', label: 'Properties' },
  ];

  return (
    <main className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-7xl mx-auto px-4 space-y-6">

        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Host Dashboard</h1>
            <p className="text-sm text-gray-500 mt-0.5">Manage your properties and track earnings</p>
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
              aria-label="Export earnings as CSV"
            >
              <Download size={15} />
              Export CSV
            </button>
            <button
              onClick={() => setShowAddProperty(true)}
              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium py-2 px-4 rounded-lg transition"
            >
              <Plus size={16} />
              Add Property
            </button>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700" role="alert">
            {error} — showing mock data below.
          </div>
        )}

        {/* Loading skeleton */}
        {isLoading && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="bg-white rounded-xl border border-gray-100 h-28 animate-pulse" />
            ))}
          </div>
        )}

        {!isLoading && (
          <>
            {/* Available Balance Banner */}
            <div className="bg-gradient-to-r from-blue-600 to-blue-700 rounded-xl shadow-md p-6 text-white flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <Wallet size={28} />
                <div>
                  <p className="text-sm text-blue-200">Available Balance</p>
                  <p className="text-3xl font-bold">
                    {(data?.pendingPayout ?? mockHostData.earningsStats.pendingPayout).toFixed(2)} USDC
                  </p>
                </div>
              </div>
              <button className="bg-white text-blue-600 hover:bg-blue-50 font-semibold py-2 px-5 rounded-lg text-sm transition">
                Withdraw Funds
              </button>
            </div>

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
                    title="Total Earnings"
                    value={`${(data?.totalEarnings ?? mockHostData.earningsStats.totalEarnings).toFixed(0)} USDC`}
                    icon={DollarSign}
                    iconColor="text-blue-600"
                    variant="gradient"
                    gradientFrom="from-blue-50"
                    gradientTo="to-blue-100"
                  />
                  <StatCard
                    title="This Month"
                    value={`${(data?.earningsThisMonth ?? mockHostData.earningsStats.thisMonth).toFixed(0)} USDC`}
                    growth={data?.earningsMoMGrowth}
                    icon={TrendingUp}
                    iconColor="text-emerald-600"
                    variant="gradient"
                    gradientFrom="from-emerald-50"
                    gradientTo="to-emerald-100"
                  />
                  <StatCard
                    title="Active Bookings"
                    value={data?.activeBookings ?? mockHostData.bookingStats.activeBookings}
                    icon={Calendar}
                    iconColor="text-indigo-600"
                  />
                  <StatCard
                    title="Avg Rating"
                    value={data?.averageRating ? `${data.averageRating} ★` : `${mockHostData.bookingStats.totalReviews} ★`}
                    subtitle={`${data?.totalReviews ?? 0} reviews`}
                    icon={Star}
                    iconColor="text-amber-500"
                  />
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <StatCard
                    title="Total Bookings"
                    value={data?.totalBookings ?? mockHostData.bookingStats.completedBookings + mockHostData.bookingStats.activeBookings}
                    icon={Home}
                    iconColor="text-violet-600"
                  />
                  <StatCard
                    title="Completed"
                    value={data?.completedBookings ?? mockHostData.bookingStats.completedBookings}
                    icon={CheckCircle}
                    iconColor="text-emerald-600"
                  />
                  <StatCard
                    title="Cancelled"
                    value={data?.cancelledBookings ?? mockHostData.bookingStats.cancelledBookings}
                    icon={XCircle}
                    iconColor="text-red-500"
                  />
                  <StatCard
                    title="Completion Rate"
                    value={`${data?.bookingCompletionRate ?? 0}%`}
                    icon={Clock}
                    iconColor="text-cyan-600"
                  />
                </div>

                {/* Charts row */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
                  <div className="lg:col-span-2">
                    <EarningsChart
                      data={data?.monthlyEarnings ?? []}
                      title="Earnings — Last 6 Months"
                    />
                  </div>
                  <OccupancyGauge
                    current={data?.occupancyRateThisMonth ?? 0}
                    previous={data?.occupancyRateLastMonth ?? 0}
                  />
                </div>

                {/* Booking trends + Transactions */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                  <BookingTrendsChart
                    data={data?.bookingTrends ?? []}
                    title="Booking Trends — Last 6 Months"
                  />
                  <RecentTransactions transactions={mockHostData.recentTransactions} />
                </div>
              </div>
            )}

            {/* ── Earnings Tab ── */}
            {activeTab === 'earnings' && (
              <div className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <StatCard
                    title="Total Earnings"
                    value={`${(data?.totalEarnings ?? 0).toFixed(2)} USDC`}
                    icon={DollarSign}
                    variant="gradient"
                    gradientFrom="from-blue-50"
                    gradientTo="to-blue-100"
                    iconColor="text-blue-600"
                  />
                  <StatCard
                    title="MoM Growth"
                    value={`${data?.earningsMoMGrowth ?? 0}%`}
                    subtitle="vs last month"
                    growth={data?.earningsMoMGrowth}
                    icon={TrendingUp}
                    iconColor="text-emerald-600"
                  />
                  <StatCard
                    title="YoY Growth"
                    value={`${data?.earningsYoYGrowth ?? 0}%`}
                    subtitle="vs same month last year"
                    growth={data?.earningsYoYGrowth}
                    icon={TrendingUp}
                    iconColor="text-violet-600"
                  />
                </div>

                <EarningsChart
                  data={data?.monthlyEarnings ?? []}
                  title="Earnings — Last 12 Months"
                />

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                  <PayoutHistory payouts={mockHostData.payoutHistory} />
                  <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
                    <h3 className="text-base font-semibold text-gray-900 mb-4">Avg Nightly Rate</h3>
                    <p className="text-4xl font-bold text-blue-600">
                      {(data?.averageNightlyRate ?? 0).toFixed(0)} USDC
                    </p>
                    <p className="text-sm text-gray-500 mt-2">Across all your properties</p>
                    <div className="mt-4 pt-4 border-t border-gray-50">
                      <p className="text-sm text-gray-500">Pending Payout</p>
                      <p className="text-2xl font-bold text-emerald-600 mt-1">
                        {(data?.pendingPayout ?? 0).toFixed(2)} USDC
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ── Properties Tab ── */}
            {activeTab === 'properties' && (
              <div className="space-y-6">
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
                  <div className="lg:col-span-2">
                    <PropertyPerformanceTable
                      properties={data?.propertyPerformance ?? []}
                    />
                  </div>
                  <OccupancyGauge
                    current={data?.occupancyRateThisMonth ?? 0}
                    previous={data?.occupancyRateLastMonth ?? 0}
                  />
                </div>
                <BookingTrendsChart
                  data={data?.bookingTrends ?? []}
                  title="Booking Activity — Last 6 Months"
                />
              </div>
            )}
          </>
        )}
      </div>

      <AddPropertyModal
        isOpen={showAddProperty}
        onClose={() => setShowAddProperty(false)}
        onSubmit={handleAddProperty}
      />
    </main>
  );
}
