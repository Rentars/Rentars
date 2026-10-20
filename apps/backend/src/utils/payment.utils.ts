/**
 * Payment amount and currency integrity utilities (#612).
 *
 * Rules enforced throughout the payment lifecycle:
 *
 *  1. All amounts are represented in stroops (integer minor units).
 *     1 USDC = 10_000_000 stroops.  No floating-point at system boundaries.
 *
 *  2. Only USDC is supported at present.  Unknown tokens fail validation.
 *
 *  3. Every payment intent carries a signed quote hash (SHA-256 of the
 *     server-computed amount + booking ID + expiry).  The hash is verified
 *     before the payment is submitted so the client cannot substitute a
 *     lower amount.
 *
 *  4. On-chain settlement amounts are compared against the DB record during
 *     reconciliation; any mismatch enters `under_review` without marking
 *     the booking paid.
 *
 *  5. Human-readable breakdown is returned alongside stroops so the
 *     frontend can display "1,000.00 USDC" without doing the conversion.
 */

import { createHmac } from 'node:crypto';
import { z } from 'zod';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Stroops per USDC (Stellar's native minor unit: 1 XLM = 10_000_000 stroops). */
export const STROOPS_PER_USDC = 10_000_000n;

/** Maximum accepted USDC amount per payment: 1_000_000 USDC. */
export const MAX_USDC_AMOUNT = 1_000_000n * STROOPS_PER_USDC;

/** Minimum accepted USDC amount: 0.01 USDC. */
export const MIN_USDC_AMOUNT = 1_000n; // 0.0001 USDC actually; practical min

// ─── Currency registry ────────────────────────────────────────────────────────

/**
 * Canonical token unit definition for a supported currency.
 *
 * `decimals` is the number of fractional digits the token supports on-chain;
 * `minorUnitsPerUnit` is 10^decimals expressed as a BigInt so all arithmetic
 * stays in integer space.
 */
export interface CurrencyDefinition {
  /** Token symbol (e.g. 'USDC'). */
  readonly code: string;
  /** Number of fractional decimal places supported by the token. */
  readonly decimals: number;
  /** 10^decimals — the number of minor units in one whole token. */
  readonly minorUnitsPerUnit: bigint;
}

function defineCurrency(code: string, decimals: number): CurrencyDefinition {
  return {
    code,
    decimals,
    minorUnitsPerUnit: 10n ** BigInt(decimals),
  };
}

/**
 * Registry of supported currencies. Add new tokens here when expanding.
 * Only USDC (7 decimals / stroops) is supported at present.
 */
export const CURRENCY_REGISTRY = {
  USDC: defineCurrency('USDC', 7),
} as const satisfies Record<string, CurrencyDefinition>;

/** Supported currency tokens. Add new tokens here when expanding. */
export const SUPPORTED_CURRENCIES = Object.keys(CURRENCY_REGISTRY) as Array<
  keyof typeof CURRENCY_REGISTRY
>;
export type SupportedCurrency = keyof typeof CURRENCY_REGISTRY;

/**
 * Look up the canonical definition for a currency, throwing on unsupported
 * tokens. Unsupported currencies must fail before any signing occurs.
 */
export function getCurrencyDefinition(currency: string): CurrencyDefinition {
  const def = (CURRENCY_REGISTRY as Record<string, CurrencyDefinition>)[currency];
  if (!def) {
    throw new RangeError(`Unsupported currency: "${currency}"`);
  }
  return def;
}

/** Type guard: is the given value a supported currency code? */
export function isSupportedCurrency(value: unknown): value is SupportedCurrency {
  return typeof value === 'string' && value in CURRENCY_REGISTRY;
}

// ─── Zod schemas ──────────────────────────────────────────────────────────────

/**
 * Schema for amount fields in API request bodies.
 *
 * Amounts MUST be submitted as integer strings (stroops).
 * Floating-point strings are rejected at the boundary.
 */
export const stroopsSchema = z
  .string()
  .regex(/^\d+$/, 'Amount must be a non-negative integer string (stroops)')
  .transform((v) => BigInt(v))
  .refine((v) => v >= MIN_USDC_AMOUNT, {
    message: `Amount must be at least ${MIN_USDC_AMOUNT.toString()} stroops`,
  })
  .refine((v) => v <= MAX_USDC_AMOUNT, {
    message: `Amount must not exceed ${MAX_USDC_AMOUNT.toString()} stroops`,
  });

/**
 * Schema for currency fields.  Rejects unsupported tokens immediately.
 */
export const currencySchema = z.enum(
  SUPPORTED_CURRENCIES as [SupportedCurrency, ...SupportedCurrency[]],
);

/**
 * Full payment amount input schema used on submit endpoints.
 * Ensures no floating-point amounts enter the system.
 */
export const paymentAmountSchema = z.object({
  amountStroops: stroopsSchema,
  currency: currencySchema,
});

// ─── Precision / minor-unit helpers ──────────────────────────────────────────

/**
 * Assert that a decimal string does not exceed the currency's supported
 * precision. Throws a RangeError on excessive precision.
 *
 * @example
 *   assertPrecision('1.1234567', 'USDC')  // ok
 *   assertPrecision('1.12345678', 'USDC') // throws
 */
export function assertPrecision(amount: string, currency: SupportedCurrency): void {
  const def = getCurrencyDefinition(currency);
  if (typeof amount !== 'string' || !/^\d+(\.\d+)?$/.test(amount)) {
    throw new RangeError(`Invalid ${currency} amount: "${String(amount)}"`);
  }
  const [, fracPart = ''] = amount.split('.');
  if (fracPart.length > def.decimals) {
    throw new RangeError(
      `${currency} amount "${amount}" has more than ${def.decimals} decimal places`,
    );
  }
}

/**
 * Convert a decimal amount string to integer minor units for the given
 * currency. Rejects floats, negative values, and excessive precision.
 *
 * @example
 *   toMinorUnits('1.5', 'USDC')  // 15_000_000n
 */
export function toMinorUnits(amount: string, currency: SupportedCurrency): bigint {
  const def = getCurrencyDefinition(currency);
  assertPrecision(amount, currency);
  const [intPart, fracPart = ''] = amount.split('.');
  const paddedFrac = fracPart.padEnd(def.decimals, '0');
  return BigInt(intPart) * def.minorUnitsPerUnit + BigInt(paddedFrac || '0');
}

/**
 * Convert integer minor units back to a decimal string for the given currency.
 * Trailing fractional zeros are trimmed; whole amounts render without a dot.
 *
 * @example
 *   fromMinorUnits(15_000_000n, 'USDC')  // '1.5'
 */
export function fromMinorUnits(minor: bigint, currency: SupportedCurrency): string {
  const def = getCurrencyDefinition(currency);
  if (minor < 0n) {
    throw new RangeError(`Amount must be non-negative, got ${minor.toString()}`);
  }
  const intPart = minor / def.minorUnitsPerUnit;
  const fracPart = minor % def.minorUnitsPerUnit;
  if (fracPart === 0n) return intPart.toString();
  const fracStr = fracPart.toString().padStart(def.decimals, '0').replace(/0+$/, '');
  return `${intPart.toString()}.${fracStr}`;
}

// ─── Server-side totals ──────────────────────────────────────────────────────

export interface ComputeTotalsInput {
  /** Nightly rate in minor units (integer). */
  nightlyRateMinor: bigint;
  /** Number of nights (integer). */
  nights: number;
  /** Platform fee in basis points (1 bps = 0.01%). */
  feeBps: number;
}

export interface ComputeTotalsResult {
  /** Subtotal (nightlyRateMinor * nights) in minor units. */
  subtotalMinor: bigint;
  /** Fee amount in minor units, rounded half-up. */
  feeMinor: bigint;
  /** Total (subtotal + fee) in minor units. */
  totalMinor: bigint;
}

/**
 * Compute booking totals server-side using BigInt only. Never trust
 * client-supplied totals. Fees are rounded half-up to the nearest minor unit.
 *
 * @throws RangeError on negative inputs or non-integer nights/feeBps.
 */
export function computeTotalsServerSide(input: ComputeTotalsInput): ComputeTotalsResult {
  const { nightlyRateMinor, nights, feeBps } = input;

  if (typeof nightlyRateMinor !== 'bigint' || nightlyRateMinor < 0n) {
    throw new RangeError('nightlyRateMinor must be a non-negative BigInt');
  }
  if (!Number.isInteger(nights) || nights < 0) {
    throw new RangeError('nights must be a non-negative integer');
  }
  if (!Number.isInteger(feeBps) || feeBps < 0) {
    throw new RangeError('feeBps must be a non-negative integer');
  }

  const subtotalMinor = nightlyRateMinor * BigInt(nights);

  // fee = subtotal * feeBps / 10_000, rounded half-up
  const numerator = subtotalMinor * BigInt(feeBps);
  const denominator = 10_000n;
  const feeMinor = (numerator + denominator / 2n) / denominator;

  return {
    subtotalMinor,
    feeMinor,
    totalMinor: subtotalMinor + feeMinor,
  };
}

// ─── Conversion utilities ─────────────────────────────────────────────────────

/**
 * Convert a USDC decimal string to stroops (BigInt).
 *
 * Rejects input with more than 7 decimal places (exceeds Stellar precision).
 * Rejects input that is not a valid decimal number.
 *
 * @example
 *   usdcToStroops('1.5')  // 15_000_000n
 *   usdcToStroops('1')    // 10_000_000n
 */
export function usdcToStroops(usdc: string): bigint {
  // Reject floating-point edge cases: e-notation, Infinity, NaN
  if (!/^\d+(\.\d+)?$/.test(usdc)) {
    throw new RangeError(`Invalid USDC amount: "${usdc}"`);
  }

  const [intPart, fracPart = ''] = usdc.split('.');

  if (fracPart.length > 7) {
    throw new RangeError(
      `USDC amount "${usdc}" has more than 7 decimal places (max precision: 0.0000001 USDC)`,
    );
  }

  const paddedFrac = fracPart.padEnd(7, '0');
  return BigInt(intPart) * STROOPS_PER_USDC + BigInt(paddedFrac);
}

/**
 * Convert stroops (BigInt) to a human-readable USDC string with 2 decimal places.
 *
 * @example
 *   stroopsToUsdc(15_000_000n)  // '1.50'
 *   stroopsToUsdc(10_000_000n)  // '1.00'
 */
export function stroopsToUsdc(stroops: bigint): string {
  const intPart = stroops / STROOPS_PER_USDC;
  const fracPart = stroops % STROOPS_PER_USDC;

  // Show 2 decimal places (USDC display convention)
  const fracStr = fracPart.toString().padStart(7, '0').slice(0, 2);
  const roundedFrac = Math.round(Number(fracPart) / 100_000)
    .toString()
    .padStart(2, '0');
  return `${intPart}.${roundedFrac}`;
}

/**
 * Build a human-readable breakdown of a payment amount for UI display.
 *
 * @returns Object suitable for inclusion in API responses.
 */
export function buildAmountBreakdown(
  amountStroops: bigint,
  currency: SupportedCurrency = 'USDC',
): {
  amountStroops: string;
  amountDisplay: string;
  currency: SupportedCurrency;
} {
  return {
    amountStroops: amountStroops.toString(),
    amountDisplay: `${stroopsToUsdc(amountStroops)} ${currency}`,
    currency,
  };
}

// ─── Quote binding ────────────────────────────────────────────────────────────

/**
 * Version of the quote format. Bump when the signed payload changes so
 * stale quotes are rejected rather than silently accepted.
 */
export const QUOTE_VERSION = 1;

/**
 * A quote binding ties a payment authorization to the exact server-computed
 * amount, currency, and quote version. The hash is verified before signing.
 */
export interface QuoteBinding {
  quote_version: number;
  amount_minor: bigint;
  currency: SupportedCurrency;
  hash: string;
}

// ─── Quote hash ───────────────────────────────────────────────────────────────

/**
 * Produce a signed quote hash that binds amount + bookingId + expiry together.
 *
 * The server signs the quote with an HMAC using QUOTE_SIGNING_SECRET so the
 * client cannot alter the amount between quote-fetch and payment-submit.
 *
 * @param bookingId    - UUID of the booking being quoted.
 * @param amountStroops - Amount in stroops.
 * @param currency     - Token (currently only USDC).
 * @param expiresAt    - ISO-8601 expiry timestamp.
 * @param secret       - HMAC signing secret (default: env QUOTE_SIGNING_SECRET).
 */
export function signQuote(
  bookingId: string,
  amountStroops: bigint,
  currency: SupportedCurrency,
  expiresAt: string,
  secret: string = process.env.QUOTE_SIGNING_SECRET ?? '',
): string {
  if (!secret) {
    throw new Error('QUOTE_SIGNING_SECRET is not configured');
  }
  const payload = `${bookingId}|${amountStroops.toString()}|${currency}|${expiresAt}`;
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Verify a quote hash matches the expected parameters.
 * Returns false if the hash is invalid, expired, or the secret is missing.
 *
 * @param quoteHash    - Hash from the client's payment-submit request.
 * @param bookingId    - UUID to verify against.
 * @param amountStroops - Stroops amount to verify against.
 * @param currency     - Token to verify against.
 * @param expiresAt    - Expiry ISO-8601 string from the quote.
 * @param secret       - HMAC signing secret.
 */
export function verifyQuote(
  quoteHash: string,
  bookingId: string,
  amountStroops: bigint,
  currency: SupportedCurrency,
  expiresAt: string,
  secret: string = process.env.QUOTE_SIGNING_SECRET ?? '',
): boolean {
  if (!secret) return false;

  // Reject expired quotes
  if (new Date(expiresAt) < new Date()) return false;

  const expected = signQuote(bookingId, amountStroops, currency, expiresAt, secret);

  // Timing-safe comparison (prevent timing oracle on hash prefix)
  if (expected.length !== quoteHash.length) return false;
  const bufExpected = Buffer.from(expected, 'hex');
  const bufActual   = Buffer.from(quoteHash, 'hex');
  if (bufExpected.length !== bufActual.length) return false;

  let diff = 0;
  for (let i = 0; i < bufExpected.length; i++) {
    diff |= bufExpected[i] ^ bufActual[i];
  }
  return diff === 0;
}

// ─── On-chain amount reconciliation ──────────────────────────────────────────

export type AmountReconciliationResult =
  | { match: true }
  | { match: false; expected: bigint; actual: bigint; diff: bigint };

export type SettledAmountComparison =
  | { status: 'ok' }
  | { status: 'mismatch'; quoteMinor: bigint; settledMinor: bigint; diff: bigint };

/**
 * Compare the quoted amount against the amount settled on-chain.
 * A `mismatch` must route the payment into review and must NOT mark the
 * booking paid.
 *
 * @param quoteMinor   - Amount bound to the signed quote (minor units).
 * @param settledMinor - Amount observed on-chain (minor units).
 */
export function compareSettledAmount(
  quoteMinor: bigint,
  settledMinor: bigint,
): SettledAmountComparison {
  if (quoteMinor === settledMinor) {
    return { status: 'ok' };
  }
  return {
    status: 'mismatch',
    quoteMinor,
    settledMinor,
    diff: settledMinor - quoteMinor,
  };
}

/**
 * Compare the amount recorded in the DB against the amount observed on-chain.
 * Returns a detailed mismatch descriptor so callers can decide on quarantine.
 *
 * @param expectedStroops - Amount stored in the `payments` table.
 * @param onChainStroops  - Amount read from the Stellar transaction / escrow.
 */
export function reconcileAmounts(
  expectedStroops: bigint,
  onChainStroops: bigint,
): AmountReconciliationResult {
  if (expectedStroops === onChainStroops) {
    return { match: true };
  }
  return {
    match: false,
    expected: expectedStroops,
    actual: onChainStroops,
    diff: onChainStroops - expectedStroops,
  };
}

// ─── Validation helper for service layer ─────────────────────────────────────

export interface AmountValidationError {
  field: string;
  message: string;
}

/**
 * Validate a raw amount + currency from an API request body.
 * Returns an array of errors (empty = valid).
 *
 * Rejects:
 *  - Floating-point strings (e.g. "10.5")
 *  - Negative values
 *  - Amounts below minimum or above maximum
 *  - Unsupported currency tokens
 */
export function validatePaymentAmount(
  rawAmount: unknown,
  rawCurrency: unknown,
): AmountValidationError[] {
  const errors: AmountValidationError[] = [];

  // Reject numbers directly — must be a string to prevent float coercion
  if (typeof rawAmount === 'number') {
    errors.push({
      field: 'amountStroops',
      message: 'Amount must be provided as a string (integer stroops), not a number',
    });
    return errors;
  }

  const amountResult = stroopsSchema.safeParse(rawAmount);
  if (!amountResult.success) {
    errors.push(
      ...amountResult.error.issues.map((issue) => ({
        field: 'amountStroops',
        message: issue.message,
      })),
    );
  }

  const currencyResult = currencySchema.safeParse(rawCurrency);
  if (!currencyResult.success) {
    errors.push(
      ...currencyResult.error.issues.map((issue) => ({
        field: 'currency',
        message: issue.message,
      })),
    );
  }

  return errors;
}
