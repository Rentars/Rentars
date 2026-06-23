'use client';

import { Calendar, MapPin, Moon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { UpcomingTrip } from '@/hooks/useTenantAnalytics';
import { format } from 'date-fns';

interface UpcomingTripsProps {
  trips: UpcomingTrip[];
}

const statusColors: Record<string, string> = {
  pending:   'bg-amber-100 text-amber-700 border-0',
  Pending:   'bg-amber-100 text-amber-700 border-0',
  confirmed: 'bg-emerald-100 text-emerald-700 border-0',
  Confirmed: 'bg-emerald-100 text-emerald-700 border-0',
};

export default function UpcomingTrips({ trips }: UpcomingTripsProps) {
  if (trips.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-8 text-center">
        <Calendar size={32} className="text-gray-300 mx-auto mb-3" />
        <p className="text-gray-500 text-sm">No upcoming trips. Start exploring properties!</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
      <div className="p-5 border-b border-gray-50">
        <h3 className="text-base font-semibold text-gray-900">Upcoming Trips</h3>
      </div>
      <div className="divide-y divide-gray-50">
        {trips.map(trip => {
          const checkIn = format(new Date(trip.check_in), 'MMM d');
          const checkOut = format(new Date(trip.check_out), 'MMM d, yyyy');
          return (
            <div key={trip.id} className="flex items-center gap-4 px-5 py-4 hover:bg-gray-50 transition-colors">
              <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center flex-shrink-0">
                <Calendar size={18} className="text-blue-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-medium text-gray-900 truncate">{trip.property_title}</p>
                <div className="flex items-center gap-3 mt-0.5">
                  <span className="flex items-center gap-1 text-xs text-gray-400">
                    <MapPin size={11} />{trip.location}
                  </span>
                  <span className="text-xs text-gray-400">{checkIn} – {checkOut}</span>
                </div>
              </div>
              <div className="text-right flex-shrink-0">
                <p className="font-semibold text-gray-900 text-sm">{trip.total_price.toFixed(0)} USDC</p>
                <div className="flex items-center justify-end gap-1 mt-1">
                  <Moon size={11} className="text-gray-400" />
                  <span className="text-xs text-gray-400">{trip.nights}n</span>
                  <Badge className={statusColors[trip.status] || 'bg-gray-100 text-gray-600 border-0'}>
                    {trip.status}
                  </Badge>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
