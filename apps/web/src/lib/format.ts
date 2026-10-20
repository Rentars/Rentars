/**
 * Formatting utilities for currency and dates with i18n support
 * These are convenience wrappers around the i18n formatting system
 */

import type { Locale } from './i18n/config';
import { formatCurrency, formatDate as formatDateI18n } from './i18n/formatting';

const DEFAULT_LOCALE: Locale = 'en';
const USDC_DECIMALS = 2;

/**
 * Canonical currency metadata: integer minor-unit precision per supported currency.
 * Amounts must be handled as integer minor units to avoid floating-point loss.
 */
const CURRENCY_DECIMALS: Record<string, number> = {
  USDC: USDC_DECIMALS,
  USD: USDC_DECIMALS,
};

/**
 * Check whether a currency is supported for canonical amount formatting.
 */
export function isSupportedCurrency(currency: string): boolean {
  return Object.prototype.hasOwnProperty.call(CURRENCY_DECIMALS, currency);
}

/**
 * Get the canonical minor-unit precision (decimals) for a supported currency.
 * Throws for unsupported currencies.
 */
export function getCurrencyDecimals(currency: string): number {
  if (!isSupportedCurrency(currency)) {
    throw new Error(`Unsupported currency: ${currency}`);
  }
  return CURRENCY_DECIMALS[currency];
}

/**
 * Format an integer amount expressed in canonical minor units (e.g. cents for
 * USDC) into a localized display string without floating-point loss.
 *
 * The integer is split into whole and fractional parts using BigInt string
 * manipulation, so no precision is lost regardless of magnitude.
 */
export function formatMinorUnits(
  amountMinor: bigint | string,
  currency: string,
  locale: Locale = DEFAULT_LOCALE
): string {
  const decimals = getCurrencyDecimals(currency);

  let minor: bigint;
  try {
    minor = typeof amountMinor === 'bigint' ? amountMinor : BigInt(amountMinor);
  } catch {
    throw new Error(`Invalid minor-unit amount: ${String(amountMinor)}`);
  }

  const negative = minor < 0n;
  const abs = negative ? -minor : minor;

  const divisor = 10n ** BigInt(decimals);
  const whole = abs / divisor;
  const fraction = abs % divisor;

  const fractionDigits = decimals > 0 ? fraction.toString().padStart(decimals, '0') : '';
  const numericString = `${negative ? '-' : ''}${whole.toString()}${
    decimals > 0 ? `.${fractionDigits}` : ''
  }`;

  // Use Intl directly on the exact decimal string to avoid Number() rounding.
  const formatter = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currency === 'USDC' ? 'USD' : currency,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

  return formatter.format(numericString as unknown as number);
}

/**
 * Format USDC amount with proper precision and locale.
 * Converts the (legacy) major-unit number into canonical minor units and
 * delegates to formatMinorUnits for lossless display.
 */
export function formatUSDC(amount: number, locale: Locale = DEFAULT_LOCALE): string {
  if (!Number.isFinite(amount)) {
    throw new Error(`Invalid USDC amount: ${amount}`);
  }
  const factor = 10 ** USDC_DECIMALS;
  const minor = BigInt(Math.round(amount * factor));
  return formatMinorUnits(minor, 'USDC', locale);
}

/**
 * Format price per night with USDC currency
 */
export function formatPricePerNight(
  pricePerNight: number,
  locale = DEFAULT_LOCALE
): string {
  return `${formatUSDC(pricePerNight, locale)} / night`;
}

/**
 * Format a date in a readable way
 */
export function formatDate(
  date: Date | string,
  locale = DEFAULT_LOCALE,
  options?: Intl.DateTimeFormatOptions
): string {
  const dateObj = typeof date === 'string' ? new Date(date) : date;

  const formatter = new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    ...options,
  });

  return formatter.format(dateObj);
}

/**
 * Format a date without year (for same-year ranges)
 */
export function formatDateShort(
  date: Date | string,
  locale = DEFAULT_LOCALE
): string {
  const dateObj = typeof date === 'string' ? new Date(date) : date;

  const formatter = new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
  });

  return formatter.format(dateObj);
}

/**
 * Format a date range
 * Examples:
 *   - "Jun 25 – Jul 2, 2026" (different months/years)
 *   - "Jun 25 – Jul 2, 2026" (same year)
 *   - "Jan 15 – 22, 2026" (same month and year)
 */
export function formatDateRange(
  startDate: Date | string,
  endDate: Date | string,
  locale = DEFAULT_LOCALE
): string {
  const start = typeof startDate === 'string' ? new Date(startDate) : startDate;
  const end = typeof endDate === 'string' ? new Date(endDate) : endDate;

  // Check if same month and year
  if (
    start.getMonth() === end.getMonth() &&
    start.getFullYear() === end.getFullYear()
  ) {
    const startFormatter = new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: 'numeric',
    });
    const endDay = end.getDate();
    return `${startFormatter.format(start)} – ${endDay}`;
  }

  // Check if same year
  if (start.getFullYear() === end.getFullYear()) {
    const startFormatter = new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: 'numeric',
    });
    const endFormatter = new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });

    return `${startFormatter.format(start)} – ${endFormatter.format(end)}`;
  }

  // Different years
  return `${formatDate(start, locale)} – ${formatDate(end, locale)}`;
}

/**
 * Format a duration in nights
 */
export function formatNights(nights: number): string {
  return nights === 1 ? '1 night' : `${nights} nights`;
}

/**
 * Format total price
 */
export function formatTotalPrice(
  pricePerNight: number,
  numberOfNights: number,
  locale = DEFAULT_LOCALE
): string {
  if (!Number.isFinite(pricePerNight) || !Number.isFinite(numberOfNights)) {
    throw new Error('Invalid price or number of nights');
  }
  const factor = 10 ** USDC_DECIMALS;
  const priceMinor = BigInt(Math.round(pricePerNight * factor));
  const totalMinor = priceMinor * BigInt(Math.round(numberOfNights));
  return formatMinorUnits(totalMinor, 'USDC', locale);
}

/**
 * Get user's preferred locale from browser
 */
export function getPreferredLocale(): string {
  if (typeof navigator === 'undefined') {
    return DEFAULT_LOCALE;
  }

  const language = navigator.language || DEFAULT_LOCALE;
  return language;
}
