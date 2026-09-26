'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { ChevronLeft, ChevronRight, Lock, AlertCircle } from 'lucide-react';

interface CalendarDay {
  date: string;
  available: boolean;
  reason?: string;
  minimum_stay_met?: boolean;
}

interface CalendarProps {
  propertyId: string;
  onSelectRange?: (checkIn: string, checkOut: string) => void;
  onDateClick?: (date: string) => void;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

/** Zero-pad a number to two digits. */
const pad = (n: number) => String(n).padStart(2, '0');

/** Build an ISO date string from year / month (1-based) / day. */
const toISO = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

export default function AvailabilityCalendar({
  propertyId,
  onSelectRange,
  onDateClick,
}: CalendarProps) {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [days, setDays] = useState<CalendarDay[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedRange, setSelectedRange] = useState<{ start?: string; end?: string }>({});

  // The ISO date string of the cell that holds DOM focus inside the grid.
  const [focusedDate, setFocusedDate] = useState<string | null>(null);

  // Live-region ref for screen-reader announcements.
  const announceRef = useRef<HTMLDivElement>(null);

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth() + 1; // 1-based

  // ── Data fetching ────────────────────────────────────────────────────────────
  // Track the last-requested property/month key so identical consecutive inputs
  // don't trigger a duplicate network request (#433).
  const lastFetchKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const fetchKey = `${propertyId}/${year}/${month}`;
    if (fetchKey === lastFetchKeyRef.current) return;
    lastFetchKeyRef.current = fetchKey;

    const fetchCalendar = async () => {
      setLoading(true);
      try {
        const res = await fetch(
          `${API_URL}/api/v1/calendar/${propertyId}/month?year=${year}&month=${month}`,
        );
        if (res.ok) {
          const data = await res.json();
          setDays(data.days || []);
        }
      } catch (err) {
        console.error('Failed to fetch calendar:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchCalendar();
  }, [propertyId, year, month]);

  // ── Live-region announcer ────────────────────────────────────────────────────
  const announce = useCallback((message: string) => {
    if (!announceRef.current) return;
    announceRef.current.textContent = '';
    // Tiny delay forces re-announcement even for identical strings.
    requestAnimationFrame(() => {
      if (announceRef.current) announceRef.current.textContent = message;
    });
  }, []);

  // ── Month navigation ─────────────────────────────────────────────────────────
  const goToPrevMonth = useCallback(() => {
    setCurrentDate((d) => {
      const next = new Date(d.getFullYear(), d.getMonth() - 1, 1);
      return next;
    });
  }, []);

  const goToNextMonth = useCallback(() => {
    setCurrentDate((d) => {
      const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
      return next;
    });
  }, []);

  // Announce month changes and move focus to the first available day (or day 1).
  useEffect(() => {
    if (loading) return;
    const monthName = new Date(year, month - 1).toLocaleString('default', {
      month: 'long',
      year: 'numeric',
    });
    announce(`Showing ${monthName}`);

    // Restore focus to same day number if it exists, otherwise fall back to first day.
    setFocusedDate((prev) => {
      if (prev) {
        const prevDay = parseInt(prev.split('-')[2], 10);
        const daysInMonth = new Date(year, month, 0).getDate();
        const day = Number.isFinite(prevDay) ? Math.min(prevDay, daysInMonth) : 1;
        return toISO(year, month, day);
      }
      return days.length > 0 ? days[0].date : toISO(year, month, 1);
    });
  }, [year, month, loading, days, announce]);

  // Focus the DOM cell whenever focusedDate changes (programmatic focus management).
  const cellRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  useEffect(() => {
    if (!focusedDate) return;
    const el = cellRefs.current.get(focusedDate);
    if (el && document.activeElement !== el) {
      el.focus({ preventScroll: false });
    }
  }, [focusedDate]);

  // ── Date selection ───────────────────────────────────────────────────────────
  const handleDateSelect = useCallback(
    (date: string, available: boolean) => {
      if (!available) return;
      onDateClick?.(date);

      if (!selectedRange.start) {
        setSelectedRange({ start: date });
        announce(`Check-in selected: ${date}. Now select a check-out date.`);
      } else if (!selectedRange.end) {
        if (date > selectedRange.start) {
          setSelectedRange({ start: selectedRange.start, end: date });
          onSelectRange?.(selectedRange.start, date);
          announce(`Check-out selected: ${date}. Range confirmed: ${selectedRange.start} to ${date}.`);
          setSelectedRange({});
        } else {
          setSelectedRange({ start: date });
          announce(`Check-in updated to: ${date}. Now select a check-out date.`);
        }
      } else {
        setSelectedRange({ start: date });
        announce(`Check-in selected: ${date}. Now select a check-out date.`);
      }
    },
    [selectedRange, onDateClick, onSelectRange, announce],
  );

  // ── Keyboard navigation ──────────────────────────────────────────────────────
  const handleGridKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!focusedDate) return;

      const [fy, fm, fd] = focusedDate.split('-').map(Number);
      const current = new Date(fy, fm - 1, fd);
      let next: Date | null = null;

      switch (e.key) {
        case 'ArrowRight':
          e.preventDefault();
          next = new Date(current);
          next.setDate(current.getDate() + 1);
          break;
        case 'ArrowLeft':
          e.preventDefault();
          next = new Date(current);
          next.setDate(current.getDate() - 1);
          break;
        case 'ArrowDown':
          e.preventDefault();
          next = new Date(current);
          next.setDate(current.getDate() + 7);
          break;
        case 'ArrowUp':
          e.preventDefault();
          next = new Date(current);
          next.setDate(current.getDate() - 7);
          break;
        case 'Home':
          // First day of the current week row.
          e.preventDefault();
          next = new Date(current);
          next.setDate(current.getDate() - current.getDay());
          break;
        case 'End':
          // Last day of the current week row.
          e.preventDefault();
          next = new Date(current);
          next.setDate(current.getDate() + (6 - current.getDay()));
          break;
        case 'PageUp':
          e.preventDefault();
          goToPrevMonth();
          return;
        case 'PageDown':
          e.preventDefault();
          goToNextMonth();
          return;
        case 'Enter':
        case ' ': {
          e.preventDefault();
          const day = days.find((d) => d.date === focusedDate);
          if (day) handleDateSelect(day.date, day.available);
          return;
        }
        default:
          return;
      }

      if (!next) return;

      const nextISO = toISO(next.getFullYear(), next.getMonth() + 1, next.getDate());

      // If the target date is in a different month, navigate there first.
      if (next.getFullYear() !== year || next.getMonth() + 1 !== month) {
        setCurrentDate(new Date(next.getFullYear(), next.getMonth(), 1));
      }

      setFocusedDate(nextISO);
    },
    [focusedDate, year, month, days, goToPrevMonth, goToNextMonth, handleDateSelect],
  );

  // ── Grid layout helpers ──────────────────────────────────────────────────────
  const daysOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const isDateInRange = (date: string) =>
    !!(selectedRange.start && selectedRange.end && date > selectedRange.start && date < selectedRange.end);
  const isStartDate = (date: string) => date === selectedRange.start;
  const isEndDate = (date: string) => date === selectedRange.end;

  const monthName = new Date(year, month - 1).toLocaleString('default', { month: 'long' });

  // Build week rows for the grid (including leading empty cells).
  const firstDayOfWeek = new Date(year, month - 1, 1).getDay();
  // Pad the front with nulls so day 1 lands on the correct column.
  const paddedDays: (CalendarDay | null)[] = [
    ...Array(firstDayOfWeek).fill(null),
    ...days,
  ];
  const weeks: (CalendarDay | null)[][] = [];
  for (let i = 0; i < paddedDays.length; i += 7) {
    weeks.push(paddedDays.slice(i, i + 7));
  }

  /** Accessible label for a single day cell. */
  const cellLabel = (day: CalendarDay): string => {
    const dateParts = new Date(day.date + 'T00:00:00').toLocaleDateString('default', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    });
    const statuses: string[] = [];
    if (!day.available) statuses.push(day.reason ? `unavailable — ${day.reason}` : 'unavailable');
    if (isStartDate(day.date)) statuses.push('selected as check-in');
    if (isEndDate(day.date)) statuses.push('selected as check-out');
    if (isDateInRange(day.date)) statuses.push('in selected range');
    return statuses.length ? `${dateParts}, ${statuses.join(', ')}` : dateParts;
  };

  return (
    <div className="bg-white dark:bg-gray-900 rounded-lg shadow-md p-6">
      {/* Hidden live region for screen-reader announcements */}
      <div
        ref={announceRef}
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      />

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <button
          onClick={goToPrevMonth}
          className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition"
          aria-label="Go to previous month"
        >
          <ChevronLeft size={20} className="text-gray-700 dark:text-gray-300" aria-hidden="true" />
        </button>
        <h2
          id="cal-heading"
          className="text-xl font-semibold text-gray-900 dark:text-white"
        >
          {monthName} {year}
        </h2>
        <button
          onClick={goToNextMonth}
          className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition"
          aria-label="Go to next month"
        >
          <ChevronRight size={20} className="text-gray-700 dark:text-gray-300" aria-hidden="true" />
        </button>
      </div>

      {loading ? (
        <div
          className="text-center py-12 text-gray-500 dark:text-gray-400"
          aria-live="polite"
          aria-busy="true"
        >
          Loading calendar…
        </div>
      ) : (
        <>
          {/* Calendar grid */}
          <div
            role="grid"
            aria-labelledby="cal-heading"
            aria-multiselectable="false"
            tabIndex={0}
            onKeyDown={handleGridKeyDown}
            className="focus:outline-none"
          >
            {/* Column headers row */}
            <div role="row" className="grid grid-cols-7 gap-2 mb-2">
              {daysOfWeek.map((day) => (
                <div
                  key={day}
                  role="columnheader"
                  aria-label={day}
                  className="text-center font-semibold text-sm text-gray-600 dark:text-gray-400 py-2"
                >
                  {day}
                </div>
              ))}
            </div>

            {/* Week rows */}
            {weeks.map((week, wi) => (
              <div key={wi} role="row" className="grid grid-cols-7 gap-2">
                {week.map((day, di) => {
                  if (!day) {
                    return (
                      <div
                        key={`empty-${wi}-${di}`}
                        role="gridcell"
                        aria-disabled="true"
                        className="p-2"
                      />
                    );
                  }

                  const isAvailable = day.available;
                  const isSelected = isStartDate(day.date) || isEndDate(day.date);
                  const isInRange = isDateInRange(day.date);
                  const isFocused = focusedDate === day.date;

                  return (
                    <div key={day.date} role="gridcell" aria-selected={isSelected}>
                      <button
                        ref={(el) => {
                          if (el) cellRefs.current.set(day.date, el);
                          else cellRefs.current.delete(day.date);
                        }}
                        tabIndex={isFocused ? 0 : -1}
                        disabled={!isAvailable}
                        aria-label={cellLabel(day)}
                        aria-pressed={isSelected}
                        aria-disabled={!isAvailable}
                        onClick={() => handleDateSelect(day.date, isAvailable)}
                        onFocus={() => setFocusedDate(day.date)}
                        className={[
                          'relative w-full p-2 rounded-lg text-sm font-medium transition',
                          'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1',
                          isSelected
                            ? 'bg-blue-600 text-white'
                            : isInRange
                            ? 'bg-blue-100 dark:bg-blue-900'
                            : !isAvailable
                            ? 'bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-600 cursor-not-allowed'
                            : 'text-gray-800 dark:text-gray-200 cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-950',
                        ].join(' ')}
                      >
                        {day.date.split('-')[2]}
                        {!isAvailable && (
                          <Lock
                            size={12}
                            className="absolute top-1 right-1"
                            aria-hidden="true"
                          />
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          {/* Legend */}
          <div className="mt-6 flex flex-wrap gap-4 text-sm text-gray-700 dark:text-gray-300">
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 bg-blue-600 rounded" aria-hidden="true" />
              <span>Selected</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 bg-blue-100 dark:bg-blue-900 rounded" aria-hidden="true" />
              <span>In range</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 bg-gray-100 dark:bg-gray-800 rounded flex items-center justify-center" aria-hidden="true">
                <Lock size={10} />
              </div>
              <span>Unavailable</span>
            </div>
          </div>

          {/* Range status */}
          {selectedRange.start && (
            <div
              className="mt-4 p-3 bg-blue-50 dark:bg-blue-950 rounded-lg flex items-start gap-2"
              aria-live="polite"
            >
              <AlertCircle size={16} className="text-blue-600 flex-shrink-0 mt-0.5" aria-hidden="true" />
              <p className="text-sm font-medium text-blue-900 dark:text-blue-200">
                {selectedRange.end
                  ? `Check-in: ${selectedRange.start} → Check-out: ${selectedRange.end}`
                  : `Check-in: ${selectedRange.start} — select a check-out date`}
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
