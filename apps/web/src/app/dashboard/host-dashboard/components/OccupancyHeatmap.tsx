'use client';

/**
 * OccupancyHeatmap
 *
 * Calendar-style heatmap showing booked / blocked / available days for a
 * host property over a selectable horizon (1, 2, or 3 months).
 *
 * Accessibility:
 *  - Status conveyed by colour AND fill-pattern (hatching for blocked,
 *    solid dot for booked) so colour-blind users are not excluded.
 *  - Each day cell has an aria-label with date + status text.
 *  - Legend items include aria-hidden decorative swatches + visible labels.
 *  - Select controls are labelled.
 */

import { useEffect, useId, useRef, useState } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

type DayStatus = 'booked' | 'blocked' | 'available';

interface DayEntry {
  date:   string;
  status: DayStatus;
}

interface HeatmapData {
  propertyId: string;
  from:       string;
  to:         string;
  days:       DayEntry[];
  summary: {
    booked:    number;
    blocked:   number;
    available: number;
    total:     number;
  };
}

interface HostProperty {
  id:    string;
  title: string;
}

export interface OccupancyHeatmapProps {
  /** List of host-owned properties to populate the property selector. */
  properties: HostProperty[];
  /** Initially selected property id. Defaults to first in the list. */
  defaultPropertyId?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const API_URL    = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
const DAY_NAMES  = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HORIZONS   = [
  { label: '1 month',  months: 1  },
  { label: '2 months', months: 2  },
  { label: '3 months', months: 3  },
] as const;

// ─── Colour / pattern map ─────────────────────────────────────────────────────

const STATUS_STYLE: Record<
  DayStatus,
  { bg: string; text: string; label: string; pattern: 'none' | 'dot' | 'hatch' }
> = {
  booked:    { bg: 'bg-blue-500',   text: 'text-white',      label: 'Booked',    pattern: 'dot'   },
  blocked:   { bg: 'bg-gray-400',   text: 'text-white',      label: 'Blocked',   pattern: 'hatch' },
  available: { bg: 'bg-green-100',  text: 'text-green-900',  label: 'Available', pattern: 'none'  },
};

// ─── Hook ─────────────────────────────────────────────────────────────────────

function useHeatmapData(propertyId: string, from: string, to: string) {
  const [data,    setData]    = useState<HeatmapData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  useEffect(() => {
    if (!propertyId || !from || !to) return;

    const controller = new AbortController();
    setLoading(true);
    setError(null);

    const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
    fetch(
      `${API_URL}/api/v1/properties/${propertyId}/occupancy-heatmap?from=${from}&to=${to}`,
      {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: controller.signal,
      },
    )
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load occupancy data (${r.status})`);
        return r.json() as Promise<HeatmapData>;
      })
      .then(setData)
      .catch((e: Error) => {
        if (e.name !== 'AbortError') setError(e.message);
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [propertyId, from, to]);

  return { data, loading, error };
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addMonths(date: Date, n: number): Date {
  const d = new Date(date);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d;
}

function formatMonthYear(isoDate: string): string {
  return new Date(isoDate + 'T00:00:00Z').toLocaleDateString('en-GB', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}

/**
 * Group an array of DayEntry into calendar months, each being a 2-D array
 * of weeks (rows) × days (cols 0-6, Sun-Sat).
 */
function groupByMonths(days: DayEntry[]): {
  monthLabel: string;
  weeks: (DayEntry | null)[][];
}[] {
  if (days.length === 0) return [];

  const months: { monthLabel: string; weeks: (DayEntry | null)[][] }[] = [];

  let currentMonth = days[0].date.slice(0, 7); // 'YYYY-MM'
  let weeks: (DayEntry | null)[][] = [];
  let week: (DayEntry | null)[] = [];

  // Pad the first week with nulls for days before the first entry
  const firstDow = new Date(days[0].date + 'T00:00:00Z').getUTCDay();
  for (let i = 0; i < firstDow; i++) week.push(null);

  for (const entry of days) {
    const entryMonth = entry.date.slice(0, 7);

    if (entryMonth !== currentMonth) {
      // Flush remaining cells for the old month
      while (week.length < 7) week.push(null);
      weeks.push(week);
      months.push({ monthLabel: formatMonthYear(currentMonth + '-01'), weeks });
      // Start fresh for new month
      currentMonth = entryMonth;
      weeks = [];
      week  = [];
      const dow = new Date(entry.date + 'T00:00:00Z').getUTCDay();
      for (let i = 0; i < dow; i++) week.push(null);
    }

    week.push(entry);
    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
  }

  // Flush the last partial week
  if (week.length > 0) {
    while (week.length < 7) week.push(null);
    weeks.push(week);
  }
  if (weeks.length > 0) {
    months.push({ monthLabel: formatMonthYear(currentMonth + '-01'), weeks });
  }

  return months;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

/** Inline SVG patterns rendered once and referenced via fill="url(#id)". */
function SvgPatternDefs({ id }: { id: string }) {
  return (
    <svg width="0" height="0" aria-hidden="true" style={{ position: 'absolute' }}>
      <defs>
        {/* Diagonal hatch for "blocked" */}
        <pattern
          id={`${id}-hatch`}
          patternUnits="userSpaceOnUse"
          width="4"
          height="4"
          patternTransform="rotate(45)"
        >
          <line x1="0" y1="0" x2="0" y2="4" stroke="rgba(255,255,255,0.55)" strokeWidth="1.5" />
        </pattern>
        {/* Centre dot for "booked" */}
        <pattern id={`${id}-dot`} patternUnits="userSpaceOnUse" width="8" height="8">
          <circle cx="4" cy="4" r="1.5" fill="rgba(255,255,255,0.55)" />
        </pattern>
      </defs>
    </svg>
  );
}

interface DayCellProps {
  entry:    DayEntry | null;
  patternId: string;
}

function DayCell({ entry, patternId }: DayCellProps) {
  if (!entry) {
    return <div className="w-8 h-8" aria-hidden="true" />;
  }

  const { bg, text, label, pattern } = STATUS_STYLE[entry.status];
  const dayNum = parseInt(entry.date.slice(8), 10);
  const ariaLabel = `${entry.date}, ${label}`;

  return (
    <div
      className={`relative w-8 h-8 rounded flex items-center justify-center text-xs font-medium select-none ${bg} ${text}`}
      aria-label={ariaLabel}
      role="gridcell"
      title={ariaLabel}
    >
      {/* Accessibility pattern overlay */}
      {pattern !== 'none' && (
        <svg
          className="absolute inset-0 w-full h-full rounded pointer-events-none"
          aria-hidden="true"
        >
          <rect
            width="100%"
            height="100%"
            fill={`url(#${patternId}-${pattern})`}
            rx="4"
          />
        </svg>
      )}
      <span className="relative z-10">{dayNum}</span>
    </div>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap gap-4 text-sm" role="list" aria-label="Heatmap legend">
      {(Object.entries(STATUS_STYLE) as [DayStatus, typeof STATUS_STYLE[DayStatus]][]).map(
        ([status, { bg, label, pattern }]) => (
          <div key={status} className="flex items-center gap-2" role="listitem">
            {/* Colour + pattern swatch */}
            <div
              className={`relative w-5 h-5 rounded ${bg} flex-shrink-0`}
              aria-hidden="true"
            >
              {pattern !== 'none' && (
                <svg className="absolute inset-0 w-full h-full rounded" aria-hidden="true">
                  <rect
                    width="100%"
                    height="100%"
                    fill={
                      pattern === 'hatch'
                        ? 'repeating-linear-gradient(45deg,rgba(0,0,0,.25) 0,rgba(0,0,0,.25) 1px,transparent 0,transparent 50%)'
                        : 'none'
                    }
                    rx="3"
                  />
                  {pattern === 'dot' && (
                    <circle cx="50%" cy="50%" r="2.5" fill="rgba(255,255,255,0.6)" />
                  )}
                </svg>
              )}
            </div>
            <span className="text-gray-700">{label}</span>
          </div>
        ),
      )}
    </div>
  );
}

function SummaryBar({ summary }: { summary: HeatmapData['summary'] }) {
  const pct = (n: number) => ((n / summary.total) * 100).toFixed(0);
  return (
    <div
      className="flex gap-4 text-sm text-gray-600 flex-wrap"
      aria-label="Occupancy summary"
    >
      <span>
        <strong className="text-blue-600">{summary.booked}</strong> booked ({pct(summary.booked)}%)
      </span>
      <span>
        <strong className="text-gray-500">{summary.blocked}</strong> blocked ({pct(summary.blocked)}%)
      </span>
      <span>
        <strong className="text-green-600">{summary.available}</strong> available ({pct(summary.available)}%)
      </span>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function OccupancyHeatmap({
  properties,
  defaultPropertyId,
}: OccupancyHeatmapProps) {
  const patternId = useId().replace(/:/g, '');

  const today   = toIsoDate(new Date());
  const [selectedPropertyId, setSelectedPropertyId] = useState(
    defaultPropertyId ?? properties[0]?.id ?? '',
  );
  const [horizonMonths, setHorizonMonths] = useState<1 | 2 | 3>(3);

  const fromDate = today;
  const toDate   = toIsoDate(addMonths(new Date(today + 'T00:00:00Z'), horizonMonths));

  const { data, loading, error } = useHeatmapData(selectedPropertyId, fromDate, toDate);

  const months = data ? groupByMonths(data.days) : [];

  const propertySelectId = `${patternId}-property-select`;
  const horizonSelectId  = `${patternId}-horizon-select`;

  return (
    <section
      className="bg-white rounded-lg shadow-sm border border-gray-100 p-6 space-y-5"
      aria-labelledby={`${patternId}-heading`}
    >
      {/* Hidden SVG pattern defs */}
      <SvgPatternDefs id={patternId} />

      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h3
          id={`${patternId}-heading`}
          className="text-lg font-semibold text-gray-900"
        >
          Occupancy Heatmap
        </h3>

        <div className="flex flex-wrap gap-3">
          {/* Property selector */}
          <div className="flex flex-col gap-0.5">
            <label htmlFor={propertySelectId} className="text-xs text-gray-500">
              Property
            </label>
            <select
              id={propertySelectId}
              value={selectedPropertyId}
              onChange={(e) => setSelectedPropertyId(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {properties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </div>

          {/* Horizon selector */}
          <div className="flex flex-col gap-0.5">
            <label htmlFor={horizonSelectId} className="text-xs text-gray-500">
              Horizon
            </label>
            <select
              id={horizonSelectId}
              value={horizonMonths}
              onChange={(e) => setHorizonMonths(Number(e.target.value) as 1 | 2 | 3)}
              className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {HORIZONS.map(({ label, months }) => (
                <option key={months} value={months}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Legend */}
      <Legend />

      {/* Calendar grid */}
      {loading && (
        <div className="flex justify-center py-10" aria-live="polite" aria-busy="true">
          <span className="text-gray-500 text-sm">Loading occupancy data…</span>
        </div>
      )}

      {error && (
        <p className="text-red-600 text-sm" role="alert">
          {error}
        </p>
      )}

      {!loading && !error && months.length === 0 && (
        <p className="text-gray-500 text-sm py-4">No data available.</p>
      )}

      {!loading && !error && months.length > 0 && (
        <div className="space-y-8" aria-live="polite">
          {months.map(({ monthLabel, weeks }) => (
            <div key={monthLabel}>
              <h4 className="text-sm font-semibold text-gray-700 mb-2">{monthLabel}</h4>

              {/* Day-of-week header */}
              <div
                className="grid grid-cols-7 gap-1 mb-1"
                aria-hidden="true"
              >
                {DAY_NAMES.map((d) => (
                  <div
                    key={d}
                    className="w-8 text-center text-xs font-medium text-gray-400"
                  >
                    {d}
                  </div>
                ))}
              </div>

              {/* Weeks */}
              <div role="grid" aria-label={monthLabel}>
                {weeks.map((week, wi) => (
                  <div key={wi} className="grid grid-cols-7 gap-1 mb-1" role="row">
                    {week.map((entry, di) => (
                      <DayCell
                        key={entry ? entry.date : `empty-${wi}-${di}`}
                        entry={entry}
                        patternId={patternId}
                      />
                    ))}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Summary bar */}
      {data && <SummaryBar summary={data.summary} />}
    </section>
  );
}
