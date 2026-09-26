# Internationalisation and Currency Policy

This document defines the authoritative rules for locale support, currency display,
settlement amounts, exchange-rate handling, and fallback behaviour across the
Rentars platform.  All new code that touches dates, numbers, currencies, or
user-visible text must comply with these rules.

---

## 1. Supported locales

| Locale code | Language | BCP 47 tag | Status |
|---|---|---|---|
| `en` | English | `en-US` | ✅ Active, reference locale |
| `es` | Spanish | `es-419` (Latin American) | ✅ Active |
| `fr` | French | `fr-FR` | ✅ Active |
| `pt` | Portuguese | `pt-BR` (Brazilian) | ✅ Active |
| `ar` | Arabic | `ar-SA` | 🗓 Planned — Q1 2027 (requires RTL layout work) |
| `de` | German | `de-DE` | 🗓 Planned — Q1 2027 |

### Adding a new locale
1. Add the code and BCP 47 tag to `apps/web/src/lib/i18n/config.ts` (`SUPPORTED_LOCALES`).
2. Add the BCP 47 tag to the `BCP47` map in `apps/web/src/lib/i18n/formatting.ts`.
3. Create `apps/web/src/lib/i18n/locales/<code>.ts` with every key from the English
   reference (`en.ts`).  Missing keys must not be left empty — use the English
   string as a placeholder and open a translation task.
4. Test pluralisation rules, decimal separators, and date formatting for the new tag.
5. For RTL locales, add the `dir="rtl"` HTML attribute and audit all flex layouts.

### Fallback behaviour
- If a translation key is missing in the active locale, the English (`en`) string
  is displayed.  The console logs a warning in development builds.
- If the locale cookie (`rntr_locale`) holds an unsupported code, the default
  locale (`en`) is used silently.

---

## 2. Settlement currency

**The settlement currency is always USDC on the Stellar network.**

- `total_price` in the `bookings` table is stored as a `DECIMAL(12, 2)` value
  denominated in **USDC**.
- No other currency is ever used for on-chain escrow or database settlement amounts.
- Receipt PDFs and booking confirmation emails use USDC as the canonical amount.
- The phrase "USD $" must not appear on receipts or confirmation screens; use
  "USDC" instead to avoid implying a 1:1 fiat equivalence guarantee to users.

---

## 3. Display currency

Users may view prices converted to a local display currency.  This is
**informational only** and must be clearly labelled.

### Supported display currencies

Defined in `apps/backend/src/services/exchangeRate.service.ts`:

`USD, EUR, GBP, JPY, CAD, AUD, CHF, CNY, BRL, INR, MXN, NGN, KES, ZAR, SGD, HKD, NOK, SEK, DKK, PLN`

To add a currency: add the ISO 4217 code to `SUPPORTED_DISPLAY_CURRENCIES` in the
exchange rate service and confirm the upstream API returns a rate for it.

### UI requirements

Every display-currency amount must show:
1. The converted amount in the user's selected currency.
2. The source USDC amount (e.g. in a tooltip or sub-label).
3. A conversion timestamp: *"Rate as of [date/time]. Settlement in USDC."*
4. A staleness warning if `stale: true` is set on the `ExchangeRates` object
   (see Section 5 below).

Example: `€92.50 ≈ 100 USDC · Rate: 23 Sep 2026 14:00 UTC`

### Currency selector
- Preference is persisted in the `rntr_currency` cookie (ISO 4217 code).
- Default: `USD` (equals USDC, no conversion required).
- The currency selector must be distinct from the locale switcher.

---

## 4. Exchange-rate policy

| Attribute | Value |
|---|---|
| Rate source | `open.er-api.com` (free tier, overrideable via `EXCHANGE_RATE_API_URL`) |
| Base currency | USD (1:1 with USDC by definition) |
| Cache TTL | 5 minutes (Redis), 4-minute background refresh loop |
| In-process fallback | Last known good rates held in memory |
| Stale threshold | Any rate older than `expires_at` is considered stale |
| Hard fallback | If no rates are available at all: show USDC amount only, no conversion |

### Stale-rate handling
When `ExchangeRates.stale === true`:
- Display the USDC amount prominently.
- Display the converted amount with a visible warning:
  *"Exchange rate may be outdated."*
- Do not fabricate a precise conversion — show the USDC amount as the definitive value.
- Log the stale event server-side via `structuredLog` at `warn` level.

### Precision rules
- USDC amounts: always 2 decimal places (`100.00 USDC`).
- Converted amounts: use the locale's standard fraction digits for the target currency
  (e.g. JPY uses 0 decimal places, EUR uses 2).  Use `Intl.NumberFormat` — never
  `toFixed()` directly.
- Never round USDC settlement amounts before storing them in the database.

---

## 5. Date and time formatting

- All dates must be formatted via `formatDate()` in
  `apps/web/src/lib/i18n/formatting.ts`.  Never call `toLocaleDateString()` directly
  on a `Date` object in component code.
- All timestamps stored in the database are `TIMESTAMPTZ` (UTC).
- Displayed timestamps must include a timezone indicator when there is any ambiguity
  (e.g. booking confirmation, escrow release time).
- Check-in/check-out dates are displayed in the property's local timezone where
  known; otherwise UTC is used and the timezone is shown explicitly.

---

## 6. Pluralisation

- All plural strings use the `{count}` token pattern defined in the translation schema.
- The frontend must never construct plural strings via JavaScript string concatenation.
  Use the `useTranslations` hook and define plural variants in the locale files.
- New locale files must include plural variants for every count-bearing string
  (e.g. `"1 night"` vs `"{count} nights"`).

---

## 7. RTL readiness

The current layout uses LTR-only flex and absolute positioning in several components.
Before adding any RTL locale:

1. Audit all `ml-`, `mr-`, `pl-`, `pr-`, `left-`, `right-` Tailwind classes and
   replace with logical equivalents (`ms-`, `me-`, `ps-`, `pe-`, `start-`, `end-`).
2. Test the Navbar, FilterSidebar, PropertyDetail, and BookingForm in RTL mode.
3. Ensure Leaflet map controls remain functional.

---

## 8. Translation ownership

| Locale | Owner / responsible team | Review cadence |
|---|---|---|
| `en` | Platform team | Every release |
| `es` | *Unassigned — needs owner* | — |
| `fr` | *Unassigned — needs owner* | — |
| `pt` | *Unassigned — needs owner* | — |

Until translation owners are assigned:
- All new UI strings are added to `en.ts` with an English value.
- Other locale files receive the same English string as a placeholder.
- A `// TODO(i18n): translate` comment is added on each placeholder.
- A GitHub issue is opened with label `i18n` and `P2` for each batch of untranslated strings.

---

## 9. Schema considerations

### Bookings table
- `total_price DECIMAL(12,2)` — USDC settlement amount, stored with full precision.
- Add `display_currency VARCHAR(3)` and `display_amount DECIMAL(14,4)` columns if
  you need to record the displayed conversion at booking time (audit trail).
  These are informational and are never used for settlement.

### Receipts and email
- Receipt PDFs must show: USDC amount, display amount (if chosen), rate source,
  rate timestamp, and the stale warning if applicable.
- Email templates follow the same rules; they are rendered server-side using the
  user's stored locale preference.

---

## 10. Testing requirements

New code touching i18n/currency must include tests for:

- [ ] Amounts formatted correctly in all four active locales (decimal separator, currency symbol position).
- [ ] Stale-rate warning is shown when `stale: true`.
- [ ] Conversion is suppressed (USDC-only display) when no valid rate is available.
- [ ] Date formatting for each locale, including cross-month and cross-year ranges.
- [ ] Pluralisation of night counts in all four locales.
- [ ] `formatSettlementAmount()` always returns the raw USDC value unchanged.

---

*Document owner: Platform team*
*Last updated: 2026-09-23*
*Next review: 2026-12-31 (Q4 roadmap review)*
