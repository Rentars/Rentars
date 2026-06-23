'use client';

import { MapPin } from 'lucide-react';

interface FavoriteLocationsProps {
  locations: { location: string; count: number }[];
}

export default function FavoriteLocations({ locations }: FavoriteLocationsProps) {
  const max = locations[0]?.count || 1;

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
      <h3 className="text-base font-semibold text-gray-900 mb-4">Favorite Destinations</h3>
      {locations.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-4">No travel data yet.</p>
      ) : (
        <div className="space-y-3">
          {locations.map(({ location, count }, i) => {
            const pct = Math.round((count / max) * 100);
            return (
              <div key={location}>
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2 text-sm">
                    <MapPin size={13} className="text-purple-500" />
                    <span className="font-medium text-gray-700 truncate max-w-[160px]">{location}</span>
                  </div>
                  <span className="text-xs text-gray-400 font-medium">{count} trip{count !== 1 ? 's' : ''}</span>
                </div>
                <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{
                      width: `${pct}%`,
                      backgroundColor: i === 0 ? '#8b5cf6' : i === 1 ? '#a78bfa' : '#c4b5fd',
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
