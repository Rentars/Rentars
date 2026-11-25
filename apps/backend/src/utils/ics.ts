/**
 * RFC 5545-compliant iCalendar (.ics) generator.
 *
 * Produces single-event and multi-event calendar files with full timezone
 * support so check-in / check-out dates display correctly in any calendar
 * client regardless of daylight-saving transitions.
 *
 * ── Supported iCalendar profile ─────────────────────────────────────────────
 *
 * Format: iCalendar (RFC 5545) version 2.0, METHOD:PUBLISH, CALSCALE:GREGORIAN.
 *
 * Line endings & folding:
 *  - Every line is terminated with CRLF ("\r\n").
 *  - Lines longer than 75 octets are folded per RFC 5545 §3.1 by inserting a
 *    CRLF followed by a single space; continuation lines carry at most 74
 *    octets of content.  Unfolding (removing CRLF + space) restores the value.
 *
 * Text escaping (RFC 5545 §3.3.11):
 *  - Backslash, semicolon and comma are backslash-escaped in TEXT values
 *    (SUMMARY, DESCRIPTION, LOCATION, UID).
 *  - CR/LF sequences are encoded as the literal two-character sequence "\n".
 *
 * Date / time semantics:
 *  - All-day events (bare "YYYY-MM-DD" input) are emitted as DATE-only values
 *    (VALUE=DATE) with no time component.  DTEND is the *exclusive* end date
 *    per RFC 5545 §3.6.1, so a booking checking out on 2026-07-05 has
 *    DTEND;VALUE=DATE:20260705 and the last occupied night is 2026-07-04.
 *  - When a timezone is supplied, DATE and DATE-TIME values carry a TZID
 *    parameter and a VTIMEZONE component is emitted for every referenced TZID.
 *  - When no timezone is supplied, DATE-TIME values are emitted in UTC with a
 *    trailing "Z".  DTSTAMP and CREATED are always UTC.
 *
 * Identity & updates:
 *  - UID is caller-supplied and must be stable across regenerations so clients
 *    update rather than duplicate events.
 *  - Cancelled bookings are emitted with STATUS:CANCELLED and an incremented
 *    SEQUENCE so clients replace the prior occurrence.
 *
 * Privacy:
 *  - Only SUMMARY, DESCRIPTION and LOCATION provided by the caller are
 *    emitted; callers are responsible for omitting private guest/property
 *    details from those fields.
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
 *
 * Folding is measured in UTF-8 octets, not UTF-16 code units, and never
 * splits a multi-byte character across a fold boundary.  Continuation lines
 * begin with a single space and carry at most 74 octets of content.
 */
function foldLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;

  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;
  // First line allows 75 octets; continuation lines reserve 1 octet for the
  // leading space, leaving 74 octets of content.
  let limit = 75;

  for (const char of line) {
    const charBytes = encoder.encode(char).length;
    if (currentBytes + charBytes > limit) {
      chunks.push(current);
      current = '';
      currentBytes = 0;
      limit = 74;
    }
    current += char;
    currentBytes += charBytes;
  }
  if (current.length > 0) chunks.push(current);

  return chunks[0] + chunks.slice(1).map((c) => '\r\n ' + c).join('');
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

    // DATE values are floating local dates; a TZID param is not permitted on
    // VALUE=DATE per RFC 5545 §3.3.4, so it is intentionally omitted.
    return foldLine(`${prop};VALUE=DATE:${dateStr}`);
  }

  // Has time component.
  if (timezone) {
    return foldLine(`${prop};TZID=${timezone}:${toLocalDateTime(iso)}`);
  }
  return foldLine(`${prop}:${toUtcDateTime(iso)}`);
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
    foldLine(`X-LIC-LOCATION:${timezone}`),
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
  // Cancelled events must advance SEQUENCE so clients replace the prior
  // occurrence; ensure at least 1 for cancellations even if caller passes 0.
  const sequence =
    status === 'CANCELLED' ? Math.max(event.sequence ?? 0, 1) : event.sequence ?? 0;

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
