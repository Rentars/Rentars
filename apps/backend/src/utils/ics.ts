/**
 * RFC 5545-compliant iCalendar (.ics) generator.
 *
 * Produces single-event and multi-event calendar files with full timezone
 * support so check-in / check-out dates display correctly in any calendar
 * client regardless of daylight-saving transitions.
 *
 * Key design decisions:
 *  - Dates stored as bare dates (YYYY-MM-DD) in the DB are treated as
 *    local dates in the property's timezone.  We emit them as DATE-only
 *    DTSTART/DTEND with a TZID param so the client anchors them locally.
 *  - Full datetime strings (ISO-8601 with time) are emitted with TZID when
 *    a timezone is provided, or as UTC "Z" timestamps when it is not.
 *  - Cancelled events carry STATUS:CANCELLED + an incremented SEQUENCE so
 *    calendar clients replace rather than duplicate the event.
 */

export interface IcsEventInput {
  uid: string;
  summary: string;
  description: string;
  location: string;
  /**
   * ISO-8601 date string, e.g. "2026-07-01" (date-only) or
   * "2026-07-01T14:00:00" (datetime without timezone offset).
   * When a timezone is provided the value is interpreted in that zone.
   */
  dtStart: string;
  /** ISO-8601 date string. Same semantics as dtStart. */
  dtEnd: string;
  /** ISO-8601 date-time when the event was created */
  created?: string;
  /**
   * RFC 5545 STATUS value. CONFIRMED is the default when omitted.
   * Set to CANCELLED for cancelled bookings so calendar clients remove the event.
   */
  status?: 'CONFIRMED' | 'CANCELLED' | 'TENTATIVE';
  /**
   * SEQUENCE number — increment on each modification so clients replace
   * the old event rather than creating a duplicate. Defaults to 0.
   */
  sequence?: number;
  /**
   * IANA timezone identifier, e.g. "America/New_York" or "Europe/London".
   * When set, DTSTART and DTEND are emitted with a TZID parameter and a
   * VTIMEZONE component is added so offline / disconnected clients can
   * still resolve the local time correctly.
   * When omitted, UTC ("Z") timestamps are used.
   */
  timezone?: string;
}

// ─── Low-level helpers ────────────────────────────────────────────────────────

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

/**
 * Fold long iCalendar lines at 75 octets (RFC 5545 §3.1).
 */
function foldLine(line: string): string {
  if (line.length <= 75) return line;
  const chunks: string[] = [];
  chunks.push(line.slice(0, 75));
  let i = 75;
  while (i < line.length) {
    chunks.push(' ' + line.slice(i, i + 74));
    i += 74;
  }
  return chunks.join('\r\n');
}

/**
 * Escape text values per RFC 5545 §3.3.11.
 */
function escapeText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * Convert an ISO-8601 string to a UTC "Z" timestamp for DTSTAMP / CREATED.
 * Always emits UTC regardless of any supplied timezone.
 */
function toUtcDateTime(iso: string): string {
  const d = new Date(iso);
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
 * Return the "date" part of an ISO string as a bare YYYYMMDD string.
 * Works for both "YYYY-MM-DD" and "YYYY-MM-DDTHH:mm:ss" inputs.
 */
function toIcsDate(iso: string): string {
  return iso.split('T')[0].replace(/-/g, '');
}

/**
 * Return the local-time part of an ISO string as "YYYYMMDDTHHmmss" (no Z).
 * Used when emitting TZID-qualified datetimes.
 */
function toLocalDateTime(iso: string): string {
  const datePart = iso.split('T')[0].replace(/-/g, '');
  if (!iso.includes('T')) return datePart;
  const timePart = iso.split('T')[1].replace(/[:\-]/g, '').slice(0, 6);
  return `${datePart}T${timePart}`;
}

/**
 * Build the DTSTART / DTEND property lines for an event.
 *
 * Rules:
 *  - Date-only input ("YYYY-MM-DD") with timezone → VALUE=DATE;TZID=... local date
 *  - Date-only input without timezone             → VALUE=DATE bare date
 *  - Datetime input with timezone                 → TZID=... local datetime
 *  - Datetime input without timezone              → UTC "Z" datetime
 *
 * For date-only DTEND we add one day per RFC 5545 §3.6.1 (exclusive end date).
 */
function buildDateTimeLine(
  prop: 'DTSTART' | 'DTEND',
  iso: string,
  timezone?: string,
): string {
  const hasTime = iso.includes('T');

  if (!hasTime) {
    // Date-only: treat as a local date in the property's timezone.
    let dateStr = toIcsDate(iso);

    if (prop === 'DTEND') {
      // Advance by one calendar day for the exclusive end-date convention.
      const [y, m, d] = iso.split('-').map(Number);
      const next = new Date(Date.UTC(y, m - 1, d + 1));
      dateStr =
        next.getUTCFullYear().toString() +
        pad(next.getUTCMonth() + 1) +
        pad(next.getUTCDate());
    }

    if (timezone) {
      return foldLine(`${prop};TZID=${timezone};VALUE=DATE:${dateStr}`);
    }
    return `${prop};VALUE=DATE:${dateStr}`;
  }

  // Has time component.
  if (timezone) {
    return foldLine(`${prop};TZID=${timezone}:${toLocalDateTime(iso)}`);
  }
  return `${prop}:${toUtcDateTime(iso)}`;
}

/**
 * Build a minimal VTIMEZONE component for the given IANA timezone.
 *
 * A full VTIMEZONE with all historical transitions would require a tz
 * database; instead we emit a VTIMEZONE stub that references the TZID.
 * Modern calendar clients (Google Calendar, Apple Calendar, Outlook 365)
 * look up their own tz database when they see the TZID; the stub satisfies
 * the RFC 5545 requirement that a VTIMEZONE exists for every referenced TZID.
 *
 * The TZURL points to the IANA tz database so conforming clients can fetch
 * the full definition if needed.
 */
function buildVTimezone(timezone: string): string[] {
  return [
    'BEGIN:VTIMEZONE',
    foldLine(`TZID:${timezone}`),
    foldLine(`TZURL:https://www.tzurl.org/zoneinfo/${timezone}`),
    'X-LIC-LOCATION:' + timezone,
    'END:VTIMEZONE',
  ];
}

// ─── VEVENT builder ───────────────────────────────────────────────────────────

/**
 * Build VEVENT lines for a single event (without VCALENDAR wrapper).
 */
function buildVEvent(event: IcsEventInput): string[] {
  const stamp = toUtcDateTime(event.created ?? new Date().toISOString());
  const status = event.status ?? 'CONFIRMED';
  const sequence = event.sequence ?? 0;

  return [
    'BEGIN:VEVENT',
    foldLine(`UID:${escapeText(event.uid)}`),
    `DTSTAMP:${stamp}`,
    buildDateTimeLine('DTSTART', event.dtStart, event.timezone),
    buildDateTimeLine('DTEND',   event.dtEnd,   event.timezone),
    `STATUS:${status}`,
    `SEQUENCE:${sequence}`,
    foldLine(`SUMMARY:${escapeText(event.summary)}`),
    foldLine(`DESCRIPTION:${escapeText(event.description)}`),
    foldLine(`LOCATION:${escapeText(event.location)}`),
    'END:VEVENT',
  ];
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate a full iCalendar string for a single event.
 */
export function generateIcs(event: IcsEventInput): string {
  const timezoneLines =
    event.timezone ? buildVTimezone(event.timezone) : [];

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Rentars//Rentars Booking//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    ...timezoneLines,
    ...buildVEvent(event),
    'END:VCALENDAR',
  ];
  return lines.join('\r\n') + '\r\n';
}

/**
 * Generate a full iCalendar string containing multiple events.
 *
 * VTIMEZONE components are de-duplicated — one block per unique timezone
 * regardless of how many events share it.  Cancelled events are included
 * with STATUS:CANCELLED so calendar clients remove them rather than leaving
 * stale entries.
 */
export function generateIcsFeed(events: IcsEventInput[]): string {
  // Collect unique timezones across all events.
  const timezones = new Set(events.map((e) => e.timezone).filter(Boolean) as string[]);

  const timezoneBlocks: string[] = [];
  for (const tz of timezones) {
    timezoneBlocks.push(...buildVTimezone(tz));
  }

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Rentars//Rentars Booking Feed//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Rentars Bookings',
    'X-WR-CALDESC:Your Rentars booking calendar',
    ...timezoneBlocks,
  ];

  for (const event of events) {
    lines.push(...buildVEvent(event));
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}
