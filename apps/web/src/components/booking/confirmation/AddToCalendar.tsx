'use client';

import { useState } from 'react';
import { CalendarPlus, Download, ChevronDown, ChevronUp } from 'lucide-react';

interface AddToCalendarProps {
  bookingId: string;
  propertyTitle: string;
  propertyLocation: string;
  checkIn: string;
  checkOut: string;
}

// ─── Provider link builders ───────────────────────────────────────────────────

/**
 * Format an ISO date string to the compact form Google Calendar expects:
 *   All-day  → YYYYMMDD
 *   With time → YYYYMMDDTHHmmssZ
 */
function toGcalDate(iso: string): string {
  if (!iso.includes('T')) {
    return iso.replace(/-/g, '');
  }
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    'T' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    'Z'
  );
}

/**
 * For all-day check-out dates we shift the end by +1 day so that the stay
 * shows as inclusive in Google Calendar (it uses half-open intervals).
 */
function toGcalEndDate(iso: string): string {
  if (!iso.includes('T')) {
    // Parse date-only values as calendar fields so the +1-day adjustment is
    // independent of the browser's local timezone.
    const [year, month, day] = iso.split('-').map(Number);
    const nextDay = new Date(Date.UTC(year, month - 1, day + 1));
    const nextYear = nextDay.getUTCFullYear();
    const nextMonth = (nextDay.getUTCMonth() + 1).toString().padStart(2, '0');
    const nextDate = nextDay.getUTCDate().toString().padStart(2, '0');
    return `${nextYear}${nextMonth}${nextDate}`;
  }
  return toGcalDate(iso);
}

function buildGoogleCalendarUrl(props: AddToCalendarProps): string {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: `Stay at ${props.propertyTitle}`,
    dates: `${toGcalDate(props.checkIn)}/${toGcalEndDate(props.checkOut)}`,
    details: `Booking ID: ${props.bookingId}`,
    location: props.propertyLocation,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function buildOutlookUrl(props: AddToCalendarProps): string {
  // Outlook Live / Outlook.com deep-link
  const startDate = props.checkIn.includes('T')
    ? new Date(props.checkIn).toISOString()
    : `${props.checkIn}T00:00:00`;
  const endDate = props.checkOut.includes('T')
    ? new Date(props.checkOut).toISOString()
    : `${props.checkOut}T00:00:00`;

  const params = new URLSearchParams({
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: `Stay at ${props.propertyTitle}`,
    startdt: startDate,
    enddt: endDate,
    body: `Booking ID: ${props.bookingId}`,
    location: props.propertyLocation,
  });
  return `https://outlook.live.com/calendar/0/deeplink/compose?${params.toString()}`;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function AddToCalendar(props: AddToCalendarProps) {
  const [open, setOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState('');

  const handleIcsDownload = async () => {
    setDownloadError('');
    setDownloading(true);
    try {
      const token =
        typeof window !== 'undefined' ? localStorage.getItem('token') : null;

      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000'}/api/v1/bookings/${props.bookingId}/calendar.ics`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      );

      if (!res.ok) {
        setDownloadError('Could not generate calendar file. Please try again.');
        return;
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `booking-${props.bookingId}.ics`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setDownloadError('Download failed. Please check your connection.');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="relative inline-block text-left">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-blue-300 bg-blue-50 text-blue-700 text-sm font-medium hover:bg-blue-100 transition focus:outline-none focus:ring-2 focus:ring-blue-500"
        aria-expanded={open}
        aria-haspopup="true"
      >
        <CalendarPlus size={16} aria-hidden="true" />
        Add to Calendar
        {open ? (
          <ChevronUp size={14} aria-hidden="true" />
        ) : (
          <ChevronDown size={14} aria-hidden="true" />
        )}
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Calendar options"
          className="absolute left-0 z-20 mt-2 w-56 rounded-lg border border-gray-200 bg-white shadow-lg"
        >
          {/* Download .ics */}
          <button
            type="button"
            role="menuitem"
            onClick={handleIcsDownload}
            disabled={downloading}
            className="flex w-full items-center gap-3 px-4 py-3 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-60 transition rounded-t-lg"
          >
            <Download size={15} className="text-gray-500 flex-shrink-0" aria-hidden="true" />
            <span>{downloading ? 'Downloading…' : 'Download .ics file'}</span>
          </button>

          <div className="border-t border-gray-100" />

          {/* Google Calendar */}
          <a
            role="menuitem"
            href={buildGoogleCalendarUrl(props)}
            target="_blank"
            rel="noopener noreferrer"
            className="flex w-full items-center gap-3 px-4 py-3 text-sm text-gray-700 hover:bg-gray-50 transition"
          >
            {/* Inline Google icon — avoids an external image dep */}
            <svg
              aria-hidden="true"
              className="flex-shrink-0"
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                fill="#4285F4"
              />
              <path
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                fill="#34A853"
              />
              <path
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"
                fill="#FBBC05"
              />
              <path
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                fill="#EA4335"
              />
            </svg>
            Google Calendar
          </a>

          <div className="border-t border-gray-100" />

          {/* Outlook */}
          <a
            role="menuitem"
            href={buildOutlookUrl(props)}
            target="_blank"
            rel="noopener noreferrer"
            className="flex w-full items-center gap-3 px-4 py-3 text-sm text-gray-700 hover:bg-gray-50 transition rounded-b-lg"
          >
            <svg
              aria-hidden="true"
              className="flex-shrink-0"
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <rect width="24" height="24" rx="3" fill="#0078D4" />
              <path
                d="M13 6h8v5h-8V6zM13 13h8v5h-8v-5zM3 6h8v12H3V6z"
                fill="white"
                opacity="0.9"
              />
            </svg>
            Outlook Calendar
          </a>
        </div>
      )}

      {downloadError && (
        <p className="mt-2 text-xs text-red-600" role="alert">
          {downloadError}
        </p>
      )}
    </div>
  );
}
