/**
 * Signed price-quote tokens (#754).
 *
 * A quote token binds an authoritative total to the exact inputs it was computed
 * for (listing, dates, listing version) and expires. Booking creation verifies the
 * token before reserving dates, so the amount a tenant confirms cannot drift from
 * the amount the server charges.
 *
 * Tokens are only issued when QUOTE_SIGNING_SECRET is configured. Without it,
 * booking still re-prices server-side; the token is an additional binding.
 */

import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Canonical token units per supported currency (#768).
 *
 * Amounts are always integers in the currency's minor unit (cents for USD,
 * stroops for XLM, etc.). Floating-point dollars never cross a trust boundary.
 */
export const CURRENCY_MINOR_UNITS: Readonly<Record<string, number>> = Object.freeze({
  USD: 2,
  EUR: 2,
  GBP: 2,
  XLM: 7,
});

/** Bumped whenever the quote computation (fees, rounding) changes. */
export const QUOTE_VERSION = 1;

export type QuoteErrorCode =
  | 'UNSUPPORTED_CURRENCY'
  | 'EXCESSIVE_PRECISION'
  | 'INVALID_AMOUNT'
  | 'INVALID_TOKEN'
  | 'EXPIRED_TOKEN'
  | 'AMOUNT_MISMATCH'
  | 'CURRENCY_MISMATCH'
  | 'VERSION_MISMATCH'
  | 'INPUT_MISMATCH';

/** Typed failure raised before any payment authorization is signed. */
export class QuoteError extends Error {
  readonly code: QuoteErrorCode;

  constructor(code: QuoteErrorCode, message: string) {
    super(message);
    this.name = 'QuoteError';
    this.code = code;
  }
}

/** True when the currency is supported and has a known minor-unit exponent. */
export function isSupportedCurrency(currency: string): boolean {
  return Object.prototype.hasOwnProperty.call(CURRENCY_MINOR_UNITS, currency);
}

/**
 * Assert an amount is a non-negative safe integer in the currency's minor unit.
 * Rejects unsupported currencies and any fractional (over-precise) amount.
 */
export function assertCanonicalAmount(amountMinor: number, currency: string): void {
  if (!isSupportedCurrency(currency)) {
    throw new QuoteError('UNSUPPORTED_CURRENCY', `Unsupported currency: ${currency}`);
  }
  if (typeof amountMinor !== 'number' || !Number.isFinite(amountMinor)) {
    throw new QuoteError('INVALID_AMOUNT', 'Amount must be a finite number');
  }
  if (!Number.isInteger(amountMinor)) {
    throw new QuoteError(
      'EXCESSIVE_PRECISION',
      `Amount ${amountMinor} exceeds ${CURRENCY_MINOR_UNITS[currency]} minor-unit precision`,
    );
  }
  if (amountMinor < 0 || !Number.isSafeInteger(amountMinor)) {
    throw new QuoteError('INVALID_AMOUNT', `Amount out of range: ${amountMinor}`);
  }
}

export interface QuoteTokenClaims {
  /** Property ID the quote was computed for. */
  pid: string;
  /** Normalised check-in instant (ISO 8601). */
  ci: string;
  /** Normalised check-out instant (ISO 8601). */
  co: string;
  /** Total the tenant is charged, as an integer in the currency's minor unit. */
  amount_minor: number;
  /** ISO 4217 code (or XLM) the amount is denominated in. */
  currency: string;
  /** Quote computation version; see QUOTE_VERSION. */
  quote_version: number;
  /** Listing version: the property's updated_at when the quote was computed. */
  ver: string;
  /** Expiry instant (ISO 8601). */
  exp: string;
}

/** Inputs a quote token must match exactly before payment is authorized. */
export interface QuoteBinding {
  pid: string;
  ci: string;
  co: string;
  amount_minor: number;
  currency: string;
  quote_version?: number;
  ver?: string;
  /** Current instant; defaults to now. */
  now?: Date;
}

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

/**
 * Produce a `<payload>.<signature>` token, or null when no signing secret is set.
 */
export function signQuoteToken(
  claims: QuoteTokenClaims,
  secret: string = process.env.QUOTE_SIGNING_SECRET ?? '',
): string | null {
  // Fail before signing on unsupported currency or over-precise amounts.
  assertCanonicalAmount(claims.amount_minor, claims.currency);
  if (!secret) return null;
  const body = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${body}.${sign(body, secret)}`;
}

/**
 * Verify a token's signature and decode its claims.
 *
 * @returns The claims when the signature is valid, otherwise null. Expiry and
 *          input matching are the caller's responsibility.
 */
export function verifyQuoteToken(
  token: string,
  secret: string = process.env.QUOTE_SIGNING_SECRET ?? '',
): QuoteTokenClaims | null {
  if (!secret || typeof token !== 'string') return null;

  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, signature] = parts;

  const expected = Buffer.from(sign(body, secret), 'utf8');
  const actual = Buffer.from(signature, 'utf8');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as QuoteTokenClaims;
  } catch {
    return null;
  }
}

/**
 * Verify a quote token against the expected binding before payment is signed.
 *
 * Checks, in order: signature, expiry, currency support, canonical amount,
 * quote version, and exact match of listing, dates, currency and amount.
 *
 * @throws QuoteError on any failure; never returns a partially-valid quote.
 */
export function verifyQuoteBinding(
  token: string,
  expected: QuoteBinding,
  secret: string = process.env.QUOTE_SIGNING_SECRET ?? '',
): QuoteTokenClaims {
  const claims = verifyQuoteToken(token, secret);
  if (!claims) throw new QuoteError('INVALID_TOKEN', 'Quote token signature is invalid');

  const now = expected.now ?? new Date();
  const expiry = Date.parse(claims.exp);
  if (!Number.isFinite(expiry) || expiry <= now.getTime()) {
    throw new QuoteError('EXPIRED_TOKEN', 'Quote token has expired');
  }

  if (!isSupportedCurrency(claims.currency)) {
    throw new QuoteError('UNSUPPORTED_CURRENCY', `Unsupported currency: ${claims.currency}`);
  }
  assertCanonicalAmount(claims.amount_minor, claims.currency);

  const expectedVersion = expected.quote_version ?? QUOTE_VERSION;
  if (claims.quote_version !== expectedVersion) {
    throw new QuoteError(
      'VERSION_MISMATCH',
      `Quote version ${claims.quote_version} does not match ${expectedVersion}`,
    );
  }

  if (claims.currency !== expected.currency) {
    throw new QuoteError(
      'CURRENCY_MISMATCH',
      `Quote currency ${claims.currency} does not match ${expected.currency}`,
    );
  }
  if (claims.amount_minor !== expected.amount_minor) {
    throw new QuoteError(
      'AMOUNT_MISMATCH',
      `Quote amount ${claims.amount_minor} does not match ${expected.amount_minor}`,
    );
  }
  if (
    claims.pid !== expected.pid ||
    claims.ci !== expected.ci ||
    claims.co !== expected.co ||
    (expected.ver !== undefined && claims.ver !== expected.ver)
  ) {
    throw new QuoteError('INPUT_MISMATCH', 'Quote inputs do not match the booking request');
  }

  return claims;
}
