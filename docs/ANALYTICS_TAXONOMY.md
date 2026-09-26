# Analytics Event Taxonomy

This document defines every analytics event the Rentars platform emits,
its schema, consent rules, retention policy, and access controls.

All instrumentation must follow this taxonomy.  Do not add ad-hoc tracking
outside this specification — file a PR against this document first.

---

## Principles

1. **Privacy by default.** Collect only what is needed to measure meaningful
   product outcomes.  Do not collect message content, wallet private keys,
   or data that can re-identify a specific person without their consent.
2. **Pseudonymous where possible.** Use `session_id` or `pseudonymous_user_id`
   rather than `user_id` when the measurement does not require knowing who
   the user is.
3. **Server-side confirmation.** Funnel events (booking created, payment
   confirmed) are emitted by the backend on confirmed state changes — never
   by client-side JavaScript alone.
4. **Schema validation.** Every event is validated against its schema before
   insert.  Invalid events are discarded and logged, not silently stored.
5. **Opt-out respected.** Users who opt out receive no analytics tracking
   beyond anonymous aggregate counts.  Opt-out state is stored in
   `user_analytics_preferences.opted_out = true`.

---

## Consent model

| Data class | Consent required | Notes |
|---|---|---|
| Anonymous aggregate counts (no user ID) | None | e.g. total searches per day |
| Pseudonymous session events | Implied (platform ToS) | `session_id` only; not linkable to identity |
| User-linked funnel events | Implied (platform ToS) | `user_id` used only for booking/payment outcomes |
| Behavioural profiling | Explicit opt-in | Not currently implemented; must not be added without opt-in |

Users can opt out of user-linked analytics at any time via
`PATCH /api/v1/profile/analytics-preferences`.  After opt-out:
- New events are recorded with `user_id = null` and `session_id` only.
- Existing user-linked rows are not retroactively deleted (retained for
  aggregate analysis) but no future rows link to that user.
- Opt-out state is stored in `user_analytics_preferences`.

---

## Retention policy

| Table | Retention | Enforcement |
|---|---|---|
| `funnel_events` | 24 months | Scheduled purge job: delete rows where `created_at < NOW() - INTERVAL '24 months'` |
| `search_analytics` | 12 months | Same pattern |
| `property_view_events` | 6 months | Same pattern |
| `analytics_daily_aggregates` | Indefinite | Pre-aggregated, no PII |

The purge job runs nightly.  Its last execution timestamp and row count are
logged to the structured log at `info` level.

---

## Event taxonomy

### 1. Search funnel

#### `search.executed`
Emitted when a search query is submitted (after debounce, server round-trip confirmed).

```json
{
  "event": "search.executed",
  "session_id": "sess_abc123",
  "user_id": null,
  "timestamp": "2026-09-23T14:00:00Z",
  "properties": {
    "query": "villa barcelona",
    "filters": {
      "city": "Barcelona",
      "min_price": 80,
      "max_price": 300,
      "guests": 2,
      "check_in": "2026-10-10",
      "check_out": "2026-10-15",
      "amenities": ["wifi", "pool"]
    },
    "result_count": 14,
    "sort_by": "price_asc",
    "page": 1
  }
}
```

- `user_id` is included only when the user is authenticated and has not opted out.
- `query` is lowercased and trimmed; whitespace-only queries are not tracked.
- `filters` must not contain wallet addresses or private data.

#### `search.zero_results`
Emitted when `result_count === 0`.  Same schema as `search.executed`.

#### `search.suggestion_accepted`
Emitted when a user clicks an autocomplete suggestion.

```json
{
  "event": "search.suggestion_accepted",
  "session_id": "sess_abc123",
  "timestamp": "2026-09-23T14:00:05Z",
  "properties": {
    "suggestion": "villa barcelona",
    "suggestion_rank": 2,
    "original_partial": "villa bar"
  }
}
```

---

### 2. Listing funnel

#### `listing.viewed`
Emitted when a property detail page is loaded (backend-confirmed HTTP 200 on
`GET /api/v1/properties/:id`).

```json
{
  "event": "listing.viewed",
  "session_id": "sess_abc123",
  "user_id": "usr_xyz",
  "timestamp": "2026-09-23T14:01:00Z",
  "properties": {
    "property_id": "prop_111",
    "referrer": "search",
    "search_position": 3
  }
}
```

- `referrer`: `"search"` | `"wishlist"` | `"direct"` | `"share"` | `"map"`.
- `search_position`: rank in the search results list (null if not from search).

#### `listing.wishlisted`
Emitted when a user adds a property to their wishlist.

```json
{
  "event": "listing.wishlisted",
  "session_id": "sess_abc123",
  "user_id": "usr_xyz",
  "timestamp": "2026-09-23T14:01:30Z",
  "properties": {
    "property_id": "prop_111"
  }
}
```

---

### 3. Booking funnel

All booking funnel events are emitted **server-side** after database/blockchain
state changes are confirmed.  No client-only booking events.

#### `booking.initiated`
Emitted when a booking record is created with status `pending`.

```json
{
  "event": "booking.initiated",
  "user_id": "usr_xyz",
  "timestamp": "2026-09-23T14:05:00Z",
  "properties": {
    "booking_id": "bkng_456",
    "property_id": "prop_111",
    "nights": 5,
    "guests": 2,
    "check_in": "2026-10-10",
    "check_out": "2026-10-15"
  }
}
```

- Do NOT include `total_price` in analytics events — amounts belong in the
  database, not the event stream.

#### `booking.confirmed`
Emitted when booking status transitions to `confirmed` (escrow locked).

```json
{
  "event": "booking.confirmed",
  "user_id": "usr_xyz",
  "timestamp": "2026-09-23T14:06:00Z",
  "properties": {
    "booking_id": "bkng_456",
    "property_id": "prop_111",
    "nights": 5
  }
}
```

#### `booking.cancelled`
Emitted when a booking is cancelled by either party.

```json
{
  "event": "booking.cancelled",
  "user_id": "usr_xyz",
  "timestamp": "2026-09-23T14:10:00Z",
  "properties": {
    "booking_id": "bkng_456",
    "cancelled_by": "tenant",
    "reason_code": "date_conflict",
    "hours_before_checkin": 168
  }
}
```

- `cancelled_by`: `"tenant"` | `"host"` | `"system"`.
- `reason_code`: free-form short code from the cancellation form; never message content.

---

### 4. Payment funnel

#### `payment.escrow_funded`
Emitted after TrustlessWork confirms escrow is locked.

```json
{
  "event": "payment.escrow_funded",
  "user_id": "usr_xyz",
  "timestamp": "2026-09-23T14:06:05Z",
  "properties": {
    "booking_id": "bkng_456",
    "escrow_id": "escrow_789",
    "stellar_network": "mainnet"
  }
}
```

- Do NOT include the USDC amount.  Amounts are in the `bookings` table.

#### `payment.escrow_released`
Emitted when escrow is released to the host.

```json
{
  "event": "payment.escrow_released",
  "user_id": "usr_xyz",
  "timestamp": "2026-10-15T12:00:00Z",
  "properties": {
    "booking_id": "bkng_456",
    "escrow_id": "escrow_789"
  }
}
```

#### `payment.escrow_refunded`
Emitted when escrow is returned to the tenant.

```json
{
  "event": "payment.escrow_refunded",
  "user_id": "usr_xyz",
  "timestamp": "2026-10-10T09:00:00Z",
  "properties": {
    "booking_id": "bkng_456",
    "escrow_id": "escrow_789",
    "refund_type": "full"
  }
}
```

- `refund_type`: `"full"` | `"partial"` | `"none"`.

#### `payment.escrow_failed`
Emitted when an escrow operation fails (network error, contract rejection).

```json
{
  "event": "payment.escrow_failed",
  "user_id": "usr_xyz",
  "timestamp": "2026-09-23T14:06:10Z",
  "properties": {
    "booking_id": "bkng_456",
    "operation": "fund",
    "error_code": "STELLAR_TX_FAILED"
  }
}
```

---

### 5. Cancellation

#### `cancellation.dispute_raised`
Emitted when a tenant or host raises a dispute.

```json
{
  "event": "cancellation.dispute_raised",
  "user_id": "usr_xyz",
  "timestamp": "2026-10-12T10:00:00Z",
  "properties": {
    "booking_id": "bkng_456",
    "raised_by": "tenant"
  }
}
```

- Do NOT include the dispute reason text (contains user-authored content).

---

## Deduplication

Each event has an implicit unique constraint on `(event, booking_id, timestamp)`
for booking/payment events.  The `funnel_events` table uses an `event_id` UUID
primary key generated server-side.  Duplicate inserts within a 60-second window
for the same `(event, booking_id)` are silently dropped by the insert trigger.

For search events, deduplication is not applied — multiple identical searches
from the same session are individually tracked.

---

## Funnel dashboard

The following funnel queries give search-to-booking and payment-completion rates.

```sql
-- Search-to-booking conversion rate (rolling 30 days)
SELECT
  COUNT(DISTINCT s.session_id)                                       AS searches,
  COUNT(DISTINCT b.session_id)                                       AS booking_initiations,
  COUNT(DISTINCT c.session_id)                                       AS booking_confirmations,
  ROUND(100.0 * COUNT(DISTINCT b.session_id) / NULLIF(COUNT(DISTINCT s.session_id), 0), 2) AS search_to_initiation_pct,
  ROUND(100.0 * COUNT(DISTINCT c.session_id) / NULLIF(COUNT(DISTINCT b.session_id), 0), 2) AS initiation_to_confirmation_pct
FROM
  (SELECT session_id FROM funnel_events WHERE event = 'search.executed'   AND created_at > NOW() - INTERVAL '30 days') s
  LEFT JOIN (SELECT session_id FROM funnel_events WHERE event = 'booking.initiated'  AND created_at > NOW() - INTERVAL '30 days') b USING (session_id)
  LEFT JOIN (SELECT session_id FROM funnel_events WHERE event = 'booking.confirmed'  AND created_at > NOW() - INTERVAL '30 days') c USING (session_id);
```

```sql
-- Payment completion rate (rolling 30 days)
SELECT
  COUNT(*) FILTER (WHERE event = 'payment.escrow_funded')    AS funded,
  COUNT(*) FILTER (WHERE event = 'payment.escrow_released')  AS released,
  COUNT(*) FILTER (WHERE event = 'payment.escrow_refunded')  AS refunded,
  COUNT(*) FILTER (WHERE event = 'payment.escrow_failed')    AS failed
FROM funnel_events
WHERE created_at > NOW() - INTERVAL '30 days';
```

These queries must not join `funnel_events` to `users` or `bookings` in reporting
dashboards — use aggregate totals only to avoid re-identifying users.

---

## Access controls

| Role | Can read | Can write |
|---|---|---|
| Analytics service account | All aggregate views | Insert only (via service) |
| Admin users | Aggregate views only; no raw `user_id` columns | No |
| Support team | Booking-specific events (by booking_id, not user_id) | No |
| External BI tool | Pre-aggregated views only | No |
| Developers (local/staging) | All (staging data only) | Yes |

Raw `funnel_events` rows containing `user_id` must not be exported to external
dashboards.  Create pre-aggregated views that suppress `user_id`.

---

## Schema

See migration `00021_create_funnel_events.sql` for the full DDL.

Key columns:

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | Server-generated primary key |
| `event` | TEXT | Event name from taxonomy above (e.g. `booking.confirmed`) |
| `session_id` | TEXT | Pseudonymous session identifier |
| `user_id` | UUID nullable | Null when user is unauthenticated or has opted out |
| `properties` | JSONB | Event-specific payload; schema-validated before insert |
| `created_at` | TIMESTAMPTZ | UTC |

---

*Document owner: Platform team*
*Last updated: 2026-09-23*
*Next review: 2026-12-31 (Q4 roadmap review)*
