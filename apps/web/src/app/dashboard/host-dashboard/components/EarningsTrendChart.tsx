'use client';

import dynamic from 'next/dynamic';

const LazyLineChart = dynamic(
  async () => {
    const mod = await import('./LazyLineChart');
    return mod.LazyLineChart;
  },
  {
    ssr: false,
    loading: () => (
      <div
        role="status"
        aria-live="polite"
        aria-busy="true"
        className="flex flex-col items-center justify-center h-[300px] gap-3"
      >
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-300 border-t-blue-500" aria-hidden="true" />
        <span className="text-sm text-gray-500 dark:text-gray-400">Loading earnings chart…</span>
      </div>
    ),
  }
);

import type { MonthlyMetric } from '../types';

interface EarningsTrendChartProps {
  data: MonthlyMetric[];
}

export default function EarningsTrendChart({ data }: EarningsTrendChartProps) {
  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-100 p-6">
      <h3 className="text-lg font-semibold text-gray-900 mb-4">Earnings & Booking Trends</h3>
      <LazyLineChart data={data} />
    </div>
  );
}
