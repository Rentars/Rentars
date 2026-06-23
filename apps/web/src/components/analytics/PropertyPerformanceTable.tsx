'use client';

import { Star, TrendingUp } from 'lucide-react';
import type { PropertyPerformance } from '@/hooks/useHostAnalytics';
import { Badge } from '@/components/ui/badge';

interface PropertyPerformanceTableProps {
  properties: PropertyPerformance[];
}

export default function PropertyPerformanceTable({ properties }: PropertyPerformanceTableProps) {
  if (properties.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-8 text-center">
        <p className="text-gray-500 text-sm">No property data available yet.</p>
      </div>
    );
  }

  const occupancyBadge = (rate: number) => {
    if (rate >= 70) return <Badge className="bg-emerald-100 text-emerald-700 border-0 text-xs">{rate}% 🔥</Badge>;
    if (rate >= 40) return <Badge className="bg-amber-100 text-amber-700 border-0 text-xs">{rate}%</Badge>;
    return <Badge className="bg-red-100 text-red-600 border-0 text-xs">{rate}%</Badge>;
  };

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
      <div className="p-5 border-b border-gray-50">
        <h3 className="text-base font-semibold text-gray-900">Property Performance</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-left">
              <th className="px-5 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Property</th>
              <th className="px-5 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide text-right">Earnings</th>
              <th className="px-5 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide text-right">Bookings</th>
              <th className="px-5 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide text-center">Occupancy</th>
              <th className="px-5 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide text-center">Rating</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {properties.map(p => (
              <tr key={p.property_id} className="hover:bg-gray-50 transition-colors">
                <td className="px-5 py-4">
                  <p className="font-medium text-gray-900 truncate max-w-[180px]">{p.title}</p>
                  <p className="text-xs text-gray-400 truncate max-w-[180px]">{p.location}</p>
                </td>
                <td className="px-5 py-4 text-right">
                  <div className="flex items-center justify-end gap-1">
                    <TrendingUp size={13} className="text-emerald-500" />
                    <span className="font-semibold text-gray-900">{p.totalEarnings.toFixed(0)} USDC</span>
                  </div>
                  <p className="text-xs text-gray-400">{p.completedBookings}/{p.totalBookings} completed</p>
                </td>
                <td className="px-5 py-4 text-right font-medium text-gray-900">{p.totalBookings}</td>
                <td className="px-5 py-4 text-center">{occupancyBadge(p.occupancyRate)}</td>
                <td className="px-5 py-4 text-center">
                  <div className="flex items-center justify-center gap-1">
                    <Star size={13} className="text-amber-400 fill-amber-400" />
                    <span className="font-medium text-gray-900">
                      {p.averageRating > 0 ? p.averageRating.toFixed(1) : '—'}
                    </span>
                    <span className="text-xs text-gray-400">({p.totalReviews})</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
