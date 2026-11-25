'use client';

import { useState, useEffect } from 'react';
import { Plus, Trash2, AlertCircle } from 'lucide-react';

interface SeasonalPricing {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  price_multiplier: number;
}

interface SpecialEvent {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  price_multiplier?: number;
  is_blocked: boolean;
}

// ─── Feature 3: typed unavailability intervals ─────────────────────────────────

type ReasonType =
  | 'confirmed_booking'
  | 'pending_booking'
  | 'expired_hold'
  | 'personal_block'
  | 'maintenance';

interface BookingContext {
  status: string;
  check_in: string;
  check_out: string;
  hold_expired: boolean;
}

interface CalendarInterval {
  id: string;
  start_date: string;
  end_date: string;
  reason_type: ReasonType;
  label: string;
  source: 'booking' | 'block';
  editable: boolean;
  booking_context?: BookingContext;
  note?: string;
}

interface IntervalsResult {
  intervals: CalendarInterval[];
  summary: Record<ReasonType, number>;
}

const REASON_LEGEND: { type: ReasonType; label: string; color: string }[] = [
  { type: 'confirmed_booking', label: 'Confirmed booking', color: '#dc2626' },
  { type: 'pending_booking', label: 'Pending booking (hold)', color: '#f59e0b' },
  { type: 'expired_hold', label: 'Expired booking hold', color: '#9ca3af' },
  { type: 'maintenance', label: 'Maintenance', color: '#8b5cf6' },
  { type: 'personal_block', label: 'Personal block', color: '#0284c7' },
];

const REASON_COLOR: Record<ReasonType, string> = Object.fromEntries(
  REASON_LEGEND.map((r) => [r.type, r.color]),
) as Record<ReasonType, string>;

interface HostCalendarProps {
  propertyId: string;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

function authHeaders(): Record<string, string> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export default function HostCalendarManagement({ propertyId }: HostCalendarProps) {
  const [seasonalPricing, setSeasonalPricing] = useState<SeasonalPricing[]>([]);
  const [specialEvents, setSpecialEvents] = useState<SpecialEvent[]>([]);
  const [intervals, setIntervals] = useState<CalendarInterval[]>([]);
  const [intervalsLoading, setIntervalsLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showPricingForm, setShowPricingForm] = useState(false);
  const [showEventForm, setShowEventForm] = useState(false);

  useEffect(() => {
    fetchData();
  }, [propertyId]);

  const fetchIntervals = async () => {
    setIntervalsLoading(true);
    try {
      const today = new Date().toISOString().slice(0, 10);
      const future = (() => {
        const d = new Date();
        d.setUTCDate(d.getUTCDate() + 90);
        return d.toISOString().slice(0, 10);
      })();
      const res = await fetch(
        `${API_URL}/api/v1/calendar/${propertyId}/intervals?from=${today}&to=${future}`,
        { headers: { ...authHeaders() } },
      );
      if (res.ok) {
        const data: IntervalsResult = await res.json();
        setIntervals(data.intervals ?? []);
      } else {
        setIntervals([]);
      }
    } catch {
      setIntervals([]);
    } finally {
      setIntervalsLoading(false);
    }
  };

  const fetchData = async () => {
    setLoading(true);
    try {
      const [pricingRes, eventRes] = await Promise.all([
        fetch(`${API_URL}/api/v1/calendar/${propertyId}/seasons`),
        fetch(`${API_URL}/api/v1/calendar/${propertyId}/availability`),
      ]);
      if (pricingRes.ok) setSeasonalPricing(await pricingRes.json());
      if (eventRes.ok) {
        const data = await eventRes.json();
        setSpecialEvents(data.filter((d: SpecialEvent | { id: string; is_available: boolean }) => 'is_blocked' in d));
      }
    } catch (err) {
      console.error('Failed to fetch calendar data:', err);
    } finally {
      setLoading(false);
    }
    // Fetch typed intervals (host-only) in parallel completion.
    fetchIntervals();
  };

  const handleAddSeasonalPricing = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    try {
      const res = await fetch(`${API_URL}/api/v1/calendar/${propertyId}/seasons`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formData.get('name'),
          start_date: formData.get('start_date'),
          end_date: formData.get('end_date'),
          price_multiplier: parseFloat(formData.get('price_multiplier') as string),
        }),
      });
      if (res.ok) { await fetchData(); setShowPricingForm(false); }
    } catch (err) { console.error('Failed to add seasonal pricing:', err); }
  };

  const handleAddSpecialEvent = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    try {
      const res = await fetch(`${API_URL}/api/v1/calendar/${propertyId}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formData.get('name'),
          start_date: formData.get('start_date'),
          end_date: formData.get('end_date'),
          price_multiplier: formData.get('price_multiplier') ? parseFloat(formData.get('price_multiplier') as string) : undefined,
          is_blocked: formData.get('is_blocked') === 'on',
        }),
      });
      if (res.ok) { await fetchData(); setShowEventForm(false); }
    } catch (err) { console.error('Failed to add special event:', err); }
  };

  const handleDeleteSeasonalPricing = async (pricingId: string) => {
    try {
      const res = await fetch(`${API_URL}/api/v1/calendar/${propertyId}/seasons/${pricingId}`, { method: 'DELETE' });
      if (res.ok) await fetchData();
    } catch (err) { console.error('Failed to delete seasonal pricing:', err); }
  };

  const handleDeleteSpecialEvent = async (eventId: string) => {
    try {
      const res = await fetch(`${API_URL}/api/v1/calendar/${propertyId}/events/${eventId}`, { method: 'DELETE' });
      if (res.ok) await fetchData();
    } catch (err) { console.error('Failed to delete special event:', err); }
  };

  const inputClass = 'w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100';

  if (loading) {
    return <div className="text-center py-8 text-gray-500 dark:text-gray-400">Loading calendar management...</div>;
  }

  return (
    <div className="space-y-8">
      {/* Feature 3: Typed unavailability intervals + legend */}
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow-md p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-3">
          Unavailability calendar
        </h3>

        {/* Legend */}
        <div className="flex flex-wrap gap-3 mb-4 text-xs text-gray-600 dark:text-gray-400">
          {REASON_LEGEND.map((entry) => (
            <span key={entry.type} className="flex items-center gap-1.5">
              <span
                className="inline-block w-3 h-3 rounded-full"
                style={{ background: entry.color }}
              />
              {entry.label}
            </span>
          ))}
        </div>

        {intervalsLoading ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">Loading unavailability…</p>
        ) : intervals.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            No unavailable dates in the next 90 days.
          </p>
        ) : (
          <ul className="space-y-2">
            {intervals.map((iv) => (
              <li
                key={`${iv.source}-${iv.id}`}
                className="flex items-start justify-between gap-3 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg"
              >
                <div className="flex items-start gap-2 flex-1">
                  <span
                    className="inline-block w-2.5 h-2.5 rounded-full mt-1.5 shrink-0"
                    style={{ background: REASON_COLOR[iv.reason_type] }}
                  />
                  <div className="min-w-0">
                    <p className="font-medium text-sm text-gray-900 dark:text-white">{iv.label}</p>
                    <p className="text-xs text-gray-600 dark:text-gray-400">
                      {iv.start_date} → {iv.end_date}
                      {iv.source === 'booking' && iv.booking_context
                        ? ` • ${iv.booking_context.status}`
                        : iv.note
                          ? ` • ${iv.note.replace(/^(maintenance|personal):/, '')}`
                          : ''}
                    </p>
                    {iv.source === 'booking' && iv.booking_context?.hold_expired && (
                      <p className="text-xs text-amber-600 dark:text-amber-500 mt-0.5">
                        Booking hold expired — these dates may be reclaimable.
                      </p>
                    )}
                  </div>
                </div>
                <span
                  className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${
                    iv.editable
                      ? 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300'
                      : 'bg-gray-200 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
                  }`}
                >
                  {iv.editable ? 'Editable' : 'Locked'}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-gray-400 dark:text-gray-500 mt-3">
          Tenant identity and payment details are never shown here. Locked intervals
          (bookings) can only be changed through the booking lifecycle, not the calendar.
        </p>
      </div>

      {/* Seasonal Pricing */}
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow-md p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Seasonal Pricing</h3>
          <button
            onClick={() => setShowPricingForm(!showPricingForm)}
            className="flex items-center gap-2 bg-blue-600 text-white px-3 py-2 rounded-lg hover:bg-blue-700 transition"
          >
            <Plus size={18} /> Add Season
          </button>
        </div>

        {showPricingForm && (
          <form onSubmit={handleAddSeasonalPricing} className="mb-6 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg space-y-4">
            <input type="text" name="name" placeholder="e.g., Summer High Season" required className={inputClass} />
            <div className="grid grid-cols-2 gap-4">
              <input type="date" name="start_date" required className={inputClass} />
              <input type="date" name="end_date" required className={inputClass} />
            </div>
            <input type="number" name="price_multiplier" placeholder="Multiplier (e.g., 1.5)" step="0.1" min="0.1" required className={inputClass} />
            <button type="submit" className="w-full bg-blue-600 text-white py-2 rounded-lg hover:bg-blue-700 transition">
              Save Season
            </button>
          </form>
        )}

        <div className="space-y-2">
          {seasonalPricing.length === 0 ? (
            <p className="text-gray-500 dark:text-gray-400 text-sm">No seasonal pricing configured</p>
          ) : (
            seasonalPricing.map((season) => (
              <div key={season.id} className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
                <div>
                  <p className="font-medium text-sm text-gray-900 dark:text-white">{season.name}</p>
                  <p className="text-xs text-gray-600 dark:text-gray-400">
                    {season.start_date} to {season.end_date} • {season.price_multiplier}x
                  </p>
                </div>
                <button onClick={() => handleDeleteSeasonalPricing(season.id)} className="p-2 text-red-600 hover:bg-red-50 dark:hover:bg-red-950 rounded-lg transition">
                  <Trash2 size={16} />
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Special Events */}
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow-md p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Special Events</h3>
          <button
            onClick={() => setShowEventForm(!showEventForm)}
            className="flex items-center gap-2 bg-blue-600 text-white px-3 py-2 rounded-lg hover:bg-blue-700 transition"
          >
            <Plus size={18} /> Add Event
          </button>
        </div>

        {showEventForm && (
          <form onSubmit={handleAddSpecialEvent} className="mb-6 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg space-y-4">
            <input type="text" name="name" placeholder="e.g., Holiday Festival" required className={inputClass} />
            <div className="grid grid-cols-2 gap-4">
              <input type="date" name="start_date" required className={inputClass} />
              <input type="date" name="end_date" required className={inputClass} />
            </div>
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-gray-700 dark:text-gray-300">
                <input type="checkbox" name="is_blocked" className="rounded" />
                <span>Block dates (unavailable)</span>
              </label>
            </div>
            <input type="number" name="price_multiplier" placeholder="Price multiplier (optional)" step="0.1" min="0.1" className={inputClass} />
            <button type="submit" className="w-full bg-blue-600 text-white py-2 rounded-lg hover:bg-blue-700 transition">
              Save Event
            </button>
          </form>
        )}

        <div className="space-y-2">
          {specialEvents.length === 0 ? (
            <p className="text-gray-500 dark:text-gray-400 text-sm">No special events configured</p>
          ) : (
            specialEvents.map((event) => (
              <div key={event.id} className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
                <div className="flex items-start gap-2 flex-1">
                  {event.is_blocked && <AlertCircle size={16} className="text-red-600 mt-0.5 flex-shrink-0" />}
                  <div>
                    <p className="font-medium text-sm text-gray-900 dark:text-white">{event.name}</p>
                    <p className="text-xs text-gray-600 dark:text-gray-400">
                      {event.start_date} to {event.end_date}
                      {event.price_multiplier && ` • ${event.price_multiplier}x`}
                    </p>
                  </div>
                </div>
                <button onClick={() => handleDeleteSpecialEvent(event.id)} className="p-2 text-red-600 hover:bg-red-50 dark:hover:bg-red-950 rounded-lg transition">
                  <Trash2 size={16} />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
