import type { Request, Response } from 'express';
import {
  getMonthAvailability,
  checkAvailabilityAtomic,
  getAvailabilityRanges,
} from '@/services/calendar.service.js';
import { generateIcsFeed } from '@/utils/ics.js';
import {
  calculateRangePrice,
  getSeasonalPricing,
  createSeasonalPricing as svcCreateSeasonalPricing,
  deleteSeasonalPricing as svcDeleteSeasonalPricing,
  createSpecialEvent as svcCreateSpecialEvent,
  deleteSpecialEvent as svcDeleteSpecialEvent,
  previewPricing,
  getPropertyQuote,
} from '@/services/pricing.service.js';

export async function getCalendarMonth(req: Request, res: Response): Promise<void> {
  const { propertyId } = req.params;
  const { year, month } = req.query;

  if (!propertyId || !year || !month) {
    res.status(400).json({ error: 'propertyId, year, and month are required' });
    return;
  }

  const yearNum = Number(year);
  const monthNum = Number(month);

  if (!Number.isInteger(yearNum) || !Number.isFinite(yearNum)) {
    res.status(422).json({ error: 'year must be a valid integer' });
    return;
  }

  if (!Number.isInteger(monthNum) || monthNum < 1 || monthNum > 12) {
    res.status(422).json({ error: 'month must be an integer between 1 and 12' });
    return;
  }

  const result = await getMonthAvailability(propertyId, yearNum, monthNum);

  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

export async function checkAvailability(req: Request, res: Response): Promise<void> {
  const { propertyId } = req.params;
  const { checkIn, checkOut } = req.query;

  if (!propertyId || !checkIn || !checkOut) {
    res.status(400).json({ error: 'propertyId, checkIn, and checkOut are required' });
    return;
  }

  const result = await checkAvailabilityAtomic(
    propertyId,
    checkIn as string,
    checkOut as string,
  );

  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

export async function getRangePrice(req: Request, res: Response): Promise<void> {
  const { propertyId } = req.params;
  const { checkIn, checkOut } = req.query;

  if (!propertyId || !checkIn || !checkOut) {
    res.status(400).json({ error: 'propertyId, checkIn, and checkOut are required' });
    return;
  }

  const result = await calculateRangePrice(propertyId, checkIn as string, checkOut as string);

  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

export async function getAvailability(req: Request, res: Response): Promise<void> {
  const { propertyId } = req.params;

  if (!propertyId) {
    res.status(400).json({ error: 'propertyId is required' });
    return;
  }

  const result = await getAvailabilityRanges(propertyId);

  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

/**
 * GET /api/v1/calendar/:propertyId/intervals?from=&to=
 *
 * Host-only: returns typed unavailability intervals (confirmed bookings,
 * pending/expired holds, personal blocks, maintenance) with safe booking
 * context and an editable flag. The response NEVER includes tenant identity or
 * payment details — only dates, booking status, and the hold-expiry flag.
 */
export async function getCalendarIntervals(req: AuthRequest, res: Response): Promise<void> {
  const hostId = req.userId;
  if (!hostId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { propertyId } = req.params;
  if (!propertyId) {
    res.status(400).json({ error: 'propertyId is required' });
    return;
  }

  // Ownership check — only the property owner may see typed calendar context.
  const { data: property, error: propError } = await supabase
    .from('properties')
    .select('owner_id')
    .eq('id', propertyId)
    .maybeSingle();

  if (propError || !property) {
    res.status(404).json({ error: 'Property not found' });
    return;
  }
  if ((property as { owner_id: string }).owner_id !== hostId) {
    res.status(403).json({ error: 'Forbidden: only the property owner can view calendar intervals' });
    return;
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  const defaultTo = (() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 90);
    return d.toISOString().slice(0, 10);
  })();
  const from = (req.query.from as string | undefined) ?? todayStr;
  const to = (req.query.to as string | undefined) ?? defaultTo;

  const result = await getHostCalendarIntervals(propertyId, from, to);
  if (!result.success) {
    const status = result.error?.match(/required|Invalid|before|366/) ? 422 : 500;
    res.status(status).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

export async function getSeasonalRates(req: Request, res: Response): Promise<void> {
  const { propertyId } = req.params;

  if (!propertyId) {
    res.status(400).json({ error: 'propertyId is required' });
    return;
  }

  const result = await getSeasonalPricing(propertyId);

  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

export async function createSeasonalRate(req: Request, res: Response): Promise<void> {
  const userId = (req as Request & { user?: { id: string } }).user?.id ?? '';
  const { propertyId } = req.params;
  const { name, start_date, end_date, price_multiplier } = req.body;

  if (!name || !start_date || !end_date || !price_multiplier) {
    res.status(400).json({ error: 'name, start_date, end_date, and price_multiplier are required' });
    return;
  }

  const result = await svcCreateSeasonalPricing(propertyId, userId, {
    name,
    start_date,
    end_date,
    price_multiplier,
    id: '',
    property_id: propertyId,
  });

  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.status(201).json(result.data);
}

export async function deleteSeasonalRate(req: Request, res: Response): Promise<void> {
  const userId = (req as Request & { user?: { id: string } }).user?.id ?? '';
  const { propertyId, pricingId } = req.params;

  const result = await svcDeleteSeasonalPricing(propertyId, pricingId, userId);

  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.status(204).send();
}

export async function createEvent(req: Request, res: Response): Promise<void> {
  const userId = (req as Request & { user?: { id: string } }).user?.id ?? '';
  const { propertyId } = req.params;
  const { name, start_date, end_date, price_multiplier, is_blocked } = req.body;

  if (!name || !start_date || !end_date) {
    res.status(400).json({ error: 'name, start_date, and end_date are required' });
    return;
  }

  const result = await svcCreateSpecialEvent(propertyId, userId, {
    name,
    start_date,
    end_date,
    price_multiplier: price_multiplier || 1,
    is_blocked: is_blocked || false,
    id: '',
    property_id: propertyId,
  });

  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.status(201).json(result.data);
}

export async function deleteEvent(req: Request, res: Response): Promise<void> {
  const userId = (req as Request & { user?: { id: string } }).user?.id ?? '';
  const { propertyId, eventId } = req.params;

  const result = await svcDeleteSpecialEvent(propertyId, eventId, userId);

  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.status(204).send();
}

export async function previewPropertyPricing(req: Request, res: Response): Promise<void> {
  const { id: propertyId } = req.params;
  const { start, end } = req.query;

  if (!start || !end) {
    res.status(400).json({ error: 'start and end query params are required' });
    return;
  }

  const result = await previewPricing(propertyId, start as string, end as string);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

export async function getPropertyQuoteHandler(req: Request, res: Response): Promise<void> {
  const { id: propertyId } = req.params;
  const { start, end, guests } = req.query;

  if (!start || !end) {
    res.status(400).json({ error: 'start and end query params are required' });
    return;
  }

  let guestCount: number | undefined;
  if (guests !== undefined) {
    const parsed = Number(guests);
    if (!Number.isInteger(parsed) || parsed < 1) {
      res.status(400).json({ error: 'guests must be a positive integer' });
      return;
    }
    guestCount = parsed;
  }

  const result = await getPropertyQuote(propertyId, start as string, end as string, guestCount);
  if (!result.success) {
    res.status(result.statusCode ?? 400).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

/**
 * Calendar feed handler.
 *
 * Supported iCalendar format:
 * - RFC 5545 compliant output with CRLF line endings and 75-octet line folding.
 * - Reserved characters (`,`, `;`, `\`, newlines) are escaped in text values.
 * - All-day events use DATE values; DTEND is exclusive (checkout day is not blocked).
 * - Timezone policy: all-day DATE values are timezone-independent, so bookings
 *   remain correct across daylight-saving transitions.
 * - Only booking statuses that block the calendar are exported; cancelled bookings
 *   are omitted so clients remove stale events.
 * - Private guest and property details are redacted; events expose only a stable
 *   UID, a generic summary, and the date range.
 *
 * Access control:
 * - Primary path: a persistent, unguessable, revocable feed token is validated
 *   against the database. Revoked or invalid tokens receive 403 without any
 *   event data being disclosed.
 * - Legacy fallback: the previous HMAC-signed token path is retained only for
 *   backwards compatibility and is documented as deprecated. It must not be
 *   used for new feeds.
 */
export async function getCalendarFeed(req: Request, res: Response): Promise<void> {
  const { propertyId } = req.params;
  const { token } = req.query;

  if (!propertyId) {
    res.status(400).json({ error: 'propertyId is required' });
    return;
  }

  if (!token || typeof token !== 'string') {
    res.status(403).json({ error: 'Invalid or revoked feed token' });
    return;
  }

  const feedService = req.app?.locals?.calendarFeedService as
    | {
        validateToken: (
          propertyId: string,
          token: string,
        ) => Promise<{ valid: boolean; revoked?: boolean }>;
        getFeedEvents: (
          propertyId: string,
        ) => Promise<
          Array<{
            uid: string;
            startDate: string;
            endDate: string;
            summary?: string;
            status?: string;
          }>
        >;
      }
    | undefined;

  if (!feedService) {
    res.status(403).json({ error: 'Invalid or revoked feed token' });
    return;
  }

  const validation = await feedService.validateToken(propertyId, token);
  if (!validation.valid || validation.revoked) {
    // Do not leak whether the property exists or has events.
    res.status(403).json({ error: 'Invalid or revoked feed token' });
    return;
  }

  const events = await feedService.getFeedEvents(propertyId);

  // Redact private details: only stable UID, generic summary, and dates are exported.
  const redacted = events
    .filter((event) => event.status !== 'cancelled')
    .map((event) => ({
      uid: event.uid,
      startDate: event.startDate,
      endDate: event.endDate,
      summary: 'Reserved',
    }));

  const ics = generateIcsFeed(redacted, { calendarName: 'Availability' });

  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="calendar.ics"');
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(200).send(ics);
}
