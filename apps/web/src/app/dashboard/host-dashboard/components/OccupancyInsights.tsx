'use client';

import { Gauge, Lightbulb } from 'lucide-react';
import { calcOccupancyRate, getPricingSuggestion } from '../analytics';
import type { OccupancyData } from '../types';

interface OccupancyInsightsProps {
  occupancy: OccupancyData;
}

export default function OccupancyInsights({ occupancy }: OccupancyInsightsProps) {
  const occupancyRate = calcOccupancyRate(occupancy);
  const suggestion = getPricingSuggestion(occupancyRate);

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-100 p-6">
      <div className="flex items-center gap-2 mb-4">
        <Gauge size={20} className="text-blue-600" />
        <h3 className="text-lg font-semibold text-gray-900">Occupancy Rate</h3>
      </div>

      <div className="mb-2 flex items-end justify-between">
        <p className="text-3xl font-bold text-gray-900">{occupancyRate.toFixed(1)}%</p>
        <p className="text-sm text-gray-500">
          {occupancy.bookedNights} / {occupancy.availableNights} nights booked
        </p>
      </div>

      <div className="w-full bg-gray-200 rounded-full h-2 mb-4">
        <div
          className="bg-blue-600 h-2 rounded-full transition-all"
          style={{ width: `${Math.max(0, Math.min(occupancyRate, 100))}%` }}
        />
      </div>

      <div className="flex items-start gap-2 bg-yellow-50 border border-yellow-200 rounded-lg p-3">
        <Lightbulb size={18} className="text-yellow-600 flex-shrink-0 mt-0.5" />
        <p className="text-sm text-yellow-800">{suggestion}</p>
      </div>
    </div>
  );
}
