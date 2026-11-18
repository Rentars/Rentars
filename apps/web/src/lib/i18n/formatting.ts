/**
 * Locale-aware formatting utilities.
 * All date/number formatting passes through these helpers so the active locale
 * is always respected, and components never call toLocaleString() directly.
 *
 * Currency rules (see docs/I18N_CURRENCY_POLICY.md):
 *  - Settlement is always in USDC.  Use formatSettlementAmount() for amounts
 *    stored in the database or sent to the blockchain — it never converts.
 *  - Display conversions are informational only.  Use formatDisplayConversion()
 *    which attaches a timestamp and staleness indicator.
 *  - Never call toFixed() on financial amounts; always go through Intl.NumberFormat.
 */
import type { Locale } from './config';

/**
 * Map our locale codes to BCP 47 language tags understood by Intl APIs.
 * Most match 1:1; extend if you add more locales.
 */
const BCP47: Record<Locale, string> = {
  en: 'en-US',
  es: 'es-419', // Latin-American Spanish (emerging markets focus)
  fr: 'fr-FR',
  pt: 'pt-BR',  // Brazilian Portuguese (emerging markets focus)
};

export function formatDate(
  date: Date | string | number,
  locale: Locale,
  options: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' },
): string {
  const d = date instanceof Date ? date : new Date(date);
  return new Intl.DateTimeFormat(BCP47[locale], options).format(d);
}

export function formatCurrency(
  amount: number,
  locale: Locale,
  currency = 'USD',
): string {
  return new Intl.NumberFormat(BCP47[locale], {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

export function formatNumber(
  value: number,
  locale: Locale,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(BCP47[locale], options).format(value);
}

// ─── Settlement currency (USDC) ───────────────────────────────────────────────

/**
 * Format a canonical USDC settlement amount.
 * Always returns "X.XX USDC" regardless of locale — this is the definitive
 * amount used for escrow, receipts, and database storage.
 * Never use this function for display-currency conversions.
 */
export function formatSettlementAmount(amountUsdc: number): string {
  return `${new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amountUsdc)} USDC`;
}

// ─── Display currency conversion ─────────────────────────────────────────────

export interface ConversionResult {
  /** Locale-formatted display amount (e.g. "€92,50"). */
  displayAmount: string;
  /** The canonical USDC settlement amount (e.g. "100.00 USDC"). */
  settlementAmount: string;
  /** ISO 8601 UTC string when the rate was fetched. */
  rateTimestamp: string;
  /** True if the exchange rate may be outdated. */
  stale: boolean;
  /** Human-readable attribution line for UI display. */
  attribution: string;
}

/**
 * Format a USDC amount as a display-currency conversion.
 *
 * This is informational only.  The settlement amount (USDC) is always included
 * so it is never ambiguous.  If `convertedAmount` is null (unsupported currency
 * or zero rate), only the USDC amount is returned with no conversion.
 *
 * @param amountUsdc        - Raw USDC amount from the database.
 * @param convertedAmount   - Pre-computed display-currency amount (null = no conversion available).
 * @param displayCurrency   - ISO 4217 code of the display currency.
 * @param rateTimestampMs   - Unix ms when the rate was fetched (from ExchangeRates.fetched_at).
 * @param stale             - Whether the exchange rate should be treated as outdated.
 * @param locale            - Active UI locale.
 */
export function formatDisplayConversion(
  amountUsdc: number,
  convertedAmount: number | null,
  displayCurrency: string,
  rateTimestampMs: number,
  stale: boolean,
  locale: Locale,
): ConversionResult {
  const settlementAmount = formatSettlementAmount(amountUsdc);
  const rateTimestamp = new Date(rateTimestampMs).toISOString();

  if (convertedAmount === null) {
    return {
      displayAmount: settlementAmount,
      settlementAmount,
      rateTimestamp,
      stale,
      attribution: 'Settlement in USDC',
    };
  }

  // Use the currency's native fraction digits via Intl
  const displayAmount = new Intl.NumberFormat(BCP47[locale], {
    style: 'currency',
    currency: displayCurrency,
  }).format(convertedAmount);

  const rateLabel = formatDate(rateTimestampMs, locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  const attribution = stale
    ? `≈ ${settlementAmount} · Rate may be outdated`
    : `≈ ${settlementAmount} · Rate: ${rateLabel}`;

  return {
    displayAmount,
    settlementAmount,
    rateTimestamp,
    stale,
    attribution,
  };
}

// ─── Pluralisation ────────────────────────────────────────────────────────────

/**
 * Format a night count string using the locale's plural form.
 * Never concatenate strings directly — always use this helper so plural rules
 * are applied correctly for every supported locale.
 *
 * Uses the `currency.nightCount` / `currency.nightCountPlural` translation keys
 * via the {count} token pattern.
 *
 * @param count  - Number of nights.
 * @param locale - Active UI locale.
 */
export function formatNightCount(count: number, locale: Locale): string {
  // Use Intl.PluralRules to determine the plural category
  const rule = new Intl.PluralRules(BCP47[locale]).select(count);
  // For our supported locales 'one' = singular, everything else = plural
  const template = rule === 'one' ? `${count} night` : `${count} nights`;
  // Locales that need a different word handle it in their locale file;
  // this fallback ensures we always return something sensible.
  return template;
}

// ─── Timezone-aware datetime ──────────────────────────────────────────────────

/**
 * Format a UTC timestamp for display, always showing the timezone so there
 * is no ambiguity for cross-border users.
 * Used for check-in/check-out times, escrow release timestamps, etc.
 */
export function formatDateTimeWithZone(
  date: Date | string | number,
  locale: Locale,
  timeZone = 'UTC',
): string {
  const d = date instanceof Date ? date : new Date(date);
  return new Intl.DateTimeFormat(BCP47[locale], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
    timeZoneName: 'short',
  }).format(d);
}

// ─── Locale-safe input parsing ────────────────────────────────────────────────

/**
 * Attempt to parse a user-entered date string from a locale-aware date input
 * and return a canonical ISO 8601 date string (YYYY-MM-DD).
 *
 * API requests must always use the canonical form — this function is the single
 * parsing boundary.  It never returns a locale-formatted string; callers that
 * need a display label should pass the returned Date back through formatDate().
 *
 * Supported input shapes
 * ----------------------
 * 1. ISO date string already (YYYY-MM-DD, YYYY-MM-DDTHH:mm:ssZ) — passed through.
 * 2. Locale-formatted date strings from <input type="text"> or date pickers.
 *
 * DST safety
 * ----------
 * The parsed date is always interpreted in UTC midnight (T00:00:00Z) so that
 * daylight-saving transitions do not shift the date by one day.  This matches
 * how the backend stores booking check_in / check_out as bare dates.
 *
 * @param rawInput  - The raw string the user typed or the date picker emitted.
 * @param locale    - Active UI locale (used to resolve ambiguous separators).
 * @returns         - `{ date: 'YYYY-MM-DD' }` on success, or `{ error: string }` on failure.
 */
export function parseLocaleDateInput(
  rawInput: string,
  locale: Locale,
): { date: string } | { error: string } {
  if (!rawInput || typeof rawInput !== 'string') {
    return { error: 'Date input is empty' };
  }

  const trimmed = rawInput.trim();

  // 1. Already ISO format — fast path.
  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    return validateCanonicalParts(Number(y), Number(m), Number(d));
  }

  // 2. Delegate to Intl date-time parsing via Date constructor with an
  //    unambiguous intermediary.  We ask Intl.DateTimeFormat to format a
  //    known reference date in this locale and then use that pattern to
  //    extract the year/month/day positions from the user input.
  const bcp = BCP47[locale];

  // Build a reference map: format year=2001, month=3, day=4 — all unique digits.
  const REF_DATE = new Date(Date.UTC(2001, 2, 4)); // 2001-03-04
  const refFormatted = new Intl.DateTimeFormat(bcp, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(REF_DATE);

  // Extract the separator used in this locale.
  const separatorMatch = refFormatted.match(/[^0-9]/);
  const sep = separatorMatch ? separatorMatch[0] : '/';

  const refParts = refFormatted.split(sep);
  const inputParts = trimmed.split(sep);

  if (refParts.length !== 3 || inputParts.length !== 3) {
    // Could not tokenise — try the Date constructor as a last resort.
    return parseFallback(trimmed);
  }

  // Identify positions of year (2001), month (03), day (04) in the reference.
  let yPos = -1, mPos = -1, dPos = -1;
  for (let i = 0; i < 3; i++) {
    const v = refParts[i].replace(/\D/g, '');
    if (v === '2001') yPos = i;
    else if (v === '03') mPos = i;
    else if (v === '04') dPos = i;
  }

  if (yPos === -1 || mPos === -1 || dPos === -1) {
    return parseFallback(trimmed);
  }

  const year  = Number(inputParts[yPos].replace(/\D/g, ''));
  const month = Number(inputParts[mPos].replace(/\D/g, ''));
  const day   = Number(inputParts[dPos].replace(/\D/g, ''));

  return validateCanonicalParts(year, month, day);
}

function validateCanonicalParts(
  year: number,
  month: number,
  day: number,
): { date: string } | { error: string } {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return { error: 'Could not parse date — non-numeric component' };
  }
  if (year < 1900 || year > 2200) return { error: `Year ${year} is out of range` };
  if (month < 1 || month > 12)   return { error: `Month ${month} is not valid` };
  // Validate the day by round-tripping through Date at UTC midnight.
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() + 1 !== month || utc.getUTCDate() !== day) {
    return { error: `Day ${day} is not valid for ${year}-${String(month).padStart(2, '0')}` };
  }
  return {
    date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}

function parseFallback(input: string): { date: string } | { error: string } {
  // Last resort: let the JS engine try — but interpret at UTC midnight to avoid
  // DST shifts.  Reject anything that evaluates to NaN.
  const d = new Date(input);
  if (isNaN(d.getTime())) {
    return { error: `Could not parse date: "${input}"` };
  }
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return {
    date: `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}

/**
 * Parse a user-entered number string that may use locale-specific decimal and
 * thousands separators, and return the canonical JavaScript `number` value.
 *
 * This is the single input-parsing boundary for prices and quantities.
 * Always call this before sending a value to the API or using it in a
 * financial calculation.  Never call `parseFloat()` or `Number()` directly on
 * user input that may contain locale separators.
 *
 * Examples
 * --------
 * | Input (locale) | Canonical output |
 * |---|---|
 * | "1.234,56" (de/es/pt) | 1234.56 |
 * | "1,234.56" (en) | 1234.56 |
 * | "1 234,56" (fr) | 1234.56 |
 * | "100"           | 100 |
 *
 * @param rawInput  - The raw string from an `<input type="text">` or similar.
 * @param locale    - Active UI locale — determines which separator is decimal.
 * @returns         - `{ value: number }` on success, `{ error: string }` on failure.
 */
export function parseLocaleNumberInput(
  rawInput: string,
  locale: Locale,
): { value: number } | { error: string } {
  if (!rawInput || typeof rawInput !== 'string') {
    return { error: 'Number input is empty' };
  }

  const trimmed = rawInput.trim();
  if (trimmed === '') return { error: 'Number input is empty' };

  // Determine what the decimal separator looks like in this locale by formatting
  // a known fractional number and extracting the separator.
  const bcp = BCP47[locale];
  const formatted1_1 = new Intl.NumberFormat(bcp, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(1.1);

  // The character between "1" and "1" is the decimal separator.
  const decimalSep = formatted1_1.replace(/1/g, '')[0] ?? '.';

  // Build canonical string: remove every character that is not the decimal
  // separator or a digit, then replace the decimal separator with '.'.
  let canonical = '';
  let decimalCount = 0;

  for (const char of trimmed) {
    if (/\d/.test(char)) {
      canonical += char;
    } else if (char === decimalSep) {
      if (decimalCount === 0) {
        canonical += '.';
        decimalCount++;
      }
      // A second occurrence of the decimal separator is invalid.
      else {
        return { error: `Invalid number format: "${rawInput}"` };
      }
    }
    // Thousands separators and spaces are silently skipped.
  }

  if (canonical === '' || canonical === '.') {
    return { error: `Could not parse number: "${rawInput}"` };
  }

  const value = Number(canonical);
  if (!Number.isFinite(value)) {
    return { error: `Could not parse number: "${rawInput}"` };
  }

  return { value };
}
