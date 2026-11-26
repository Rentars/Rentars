import { Router } from 'express';
import { getCalendarFeed } from '@/controllers/booking.controller.js';

const router = Router();

// Public calendar feed endpoint — authenticated via a persistent, revocable
// DB-backed token embedded in the URL path.
//
// Supported format:
//   - The feed is served as an iCalendar (RFC 5545) document with
//     `Content-Type: text/calendar; charset=utf-8`.
//   - Events are emitted as all-day events using DTSTART/DTEND with
//     exclusive DTEND (i.e. DTEND is the day after the last booked day),
//     per the iCalendar all-day boundary convention.
//   - Lines use CRLF terminators and RFC 5545 folding for long lines;
//     reserved characters are escaped.
//   - Dates are represented in UTC; clients localize them for display.
//
// Token semantics:
//   - The token is a 64-char hex string stored in the database.
//   - Tokens are unguessable and revocable. Revoking a token (or using an
//     unknown token) yields a 403 Forbidden response and exposes no events.
//   - Calendar apps commonly append a `.ics` suffix to feed URLs, so the
//     optional `.ics` suffix is stripped before the token is passed to the
//     controller.
//
// GET /api/v1/calendar/feed/:token[.ics]
router.get('/feed/:token', (req, res, next) => {
  const rawToken = req.params.token ?? '';
  const token = rawToken.endsWith('.ics')
    ? rawToken.slice(0, -'.ics'.length)
    : rawToken;

  // Reject malformed tokens early; the controller performs the authoritative
  // DB lookup and returns 403 for revoked or unknown tokens.
  if (!/^[0-9a-f]{64}$/i.test(token)) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  req.params.token = token;
  return getCalendarFeed(req, res, next);
});

export default router;