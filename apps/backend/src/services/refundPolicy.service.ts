/**
 * Refund policy — determines how much of a booking's total price is refunded to
 * the tenant when they cancel, based on how close the cancellation is to the
 * scheduled check-in.
 *
 * Tiers (configurable via environment variables):
 *   • FULL    — cancellation is far enough out → 100% refund.
 *   • PARTIAL — cancellation is inside the full-refund window but outside the
 *               no-refund window → a configurable percentage refund.
 *   • NONE    — cancellation is inside the no-refund window (e.g. within 48h)
 *               → no refund.
 *
 * The policy is intentionally a pure, side-effect-free calculation so it can be
 * unit-tested exhaustively and reused by the booking service, admin tooling,
 * and analytics without touching the database or escrow.
 */

export type RefundTierId = 'full' | 'partial' | 'none';

export interface RefundPolicyConfig {
  /** Cancellations at or beyond this many hours before check-in get a full refund. */
  fullRefundHours: number;
  /** Cancellations inside this many hours before check-in get NO refund. */
  noRefundHours: number;
  /** Refund fraction (0..1) applied in the partial window. */
  partialRefundPct: number;
}

/**
 * The refund terms captured at booking time. Refund execution must always be
 * reconciled against this snapshot — never against the currently active policy —
 * so that later policy changes cannot retroactively alter a guest's entitlement.
 */
export interface RefundPolicySnapshot {
  /** Identifier of the policy version that was active when the booking was made. */
  policyId: string;
  /** The tier thresholds and percentages that applied at booking time. */
  config: RefundPolicyConfig;
  /** ISO timestamp of when the snapshot was captured. */
  capturedAt: string;
}

export interface RefundComputation {
  /** Which tier the cancellation fell into. */
  tier: RefundTierId;
  /** Refund fraction applied (0..1). */
  refundPct: number;
  /** Absolute refund amount in the same currency units as `totalPrice`. */
  refundAmount: number;
  /** The booking's total price that the refund was computed against. */
  totalPrice: number;
  /** Hours between the cancellation time and the check-in time (can be negative). */
  hoursUntilCheckIn: number;
  /** The policy configuration that produced this result. */
  policy: RefundPolicyConfig;
}

/**
 * Result of computing refund eligibility from a booking-time policy snapshot.
 * All monetary values are integer minor units (e.g. cents) to avoid floating
 * point drift between calculation, persistence, and provider submission.
 */
export interface RefundCalculation {
  /** Which tier the cancellation fell into. */
  tier: RefundTierId;
  /** Refund fraction applied (0..1). */
  refundPct: number;
  /** Refund amount in integer minor units, capped at the eligible value. */
  refundAmountMinor: number;
  /** Maximum refundable amount in integer minor units (the eligible value). */
  eligibleAmountMinor: number;
  /** Booking total in integer minor units that the refund was computed against. */
  totalAmountMinor: number;
  /** ISO 4217 currency code of the booking. */
  currency: string;
  /** Reference to the policy snapshot used for the calculation. */
  policySnapshot: RefundPolicySnapshot;
  /** Hours between the cancellation time and the check-in time (can be negative). */
  hoursUntilCheckIn: number;
}

/** Minimal booking shape needed to compute a refund from the snapshot. */
export interface RefundableBooking {
  id: string;
  /** Canonical check-in timestamp (ISO string or Date). */
  checkIn: string | Date;
  /** Booking total in integer minor units. */
  totalAmountMinor: number;
  /** ISO 4217 currency code. */
  currency: string;
  /** Policy snapshot captured at booking time. */
  refundPolicySnapshot: RefundPolicySnapshot;
}

/**
 * Loads a booking for refund calculation. Injected so the pure calculation can
 * be reused by the cancellation preview endpoint, the refund executor, and
 * tests without coupling to a specific persistence layer.
 */
export type RefundableBookingLoader = (bookingId: string) => Promise<RefundableBooking | null>;
======

<<<<<<< SEARCH
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
=======
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function assertMinorUnits(value: number, label: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer in minor units`);
  }
}

function toDate(value: string | Date, label: string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (isNaN(date.getTime())) {
    throw new Error(`${label} must be a valid date`);
  }
  return date;
}

/**
 * Compute refund eligibility from the booking-time policy snapshot using
 * canonical timestamps and integer minor units.
 *
 * The refund amount is always capped at the eligible value so that rounding or
 * a misconfigured snapshot can never produce a refund larger than the booking
 * total or larger than the tier entitlement.
 *
 * @param params.booking      - Booking with its captured policy snapshot.
 * @param params.cancelledAt  - Canonical cancellation timestamp (default: now).
 *
 * @throws Error if the booking is missing a snapshot, amounts are not integer
 *         minor units, or timestamps are invalid.
 */
export function computeRefundFromSnapshot(params: {
  booking: RefundableBooking;
  cancelledAt?: Date | string;
}): RefundCalculation {
  const { booking, cancelledAt } = params;

  if (!booking.refundPolicySnapshot || !booking.refundPolicySnapshot.config) {
    throw new Error('booking is missing a refund policy snapshot');
  }

  assertMinorUnits(booking.totalAmountMinor, 'totalAmountMinor');
  if (typeof booking.currency !== 'string' || booking.currency.trim() === '') {
    throw new Error('currency is required');
  }

  const checkInDate = toDate(booking.checkIn, 'checkIn');
  const cancelDate = toDate(cancelledAt ?? new Date(), 'cancelledAt');

  const policy = booking.refundPolicySnapshot.config;
  const hoursUntilCheckIn = (checkInDate.getTime() - cancelDate.getTime()) / (1000 * 60 * 60);
  const tier = resolveRefundTier(hoursUntilCheckIn, policy);

  const refundPct = tier === 'full' ? 1 : tier === 'partial' ? policy.partialRefundPct : 0;

  // Eligible value is the booking total; the tier entitlement is a fraction of it.
  const eligibleAmountMinor = booking.totalAmountMinor;
  const rawRefundMinor = Math.round(eligibleAmountMinor * refundPct);
  const refundAmountMinor = Math.min(Math.max(rawRefundMinor, 0), eligibleAmountMinor);

  return {
    tier,
    refundPct,
    refundAmountMinor,
    eligibleAmountMinor,
    totalAmountMinor: booking.totalAmountMinor,
    currency: booking.currency,
    policySnapshot: booking.refundPolicySnapshot,
    hoursUntilCheckIn,
  };
}

/**
 * Preview the refund a guest would receive if they cancelled now (or at the
 * supplied time). Used by the cancellation preview endpoint so users see the
 * calculation before confirming cancellation.
 *
 * @throws Error if the booking cannot be found.
 */
export async function previewRefund(
  bookingId: string,
  cancelledAt: Date | string | undefined,
  loadBooking: RefundableBookingLoader,
): Promise<RefundCalculation> {
  const booking = await loadBooking(bookingId);
  if (!booking) {
    throw new Error(`booking ${bookingId} not found`);
  }
  return computeRefundFromSnapshot({ booking, cancelledAt });
}

const DEFAULT_REFUND_POLICY: RefundPolicyConfig = {
  fullRefundHours: 7 * 24, // 168h — "7+ days out"
  noRefundHours: 48, // "within 48 hours"
  partialRefundPct: 0.5, // 50% in the in-between window
};

function parseHours(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parsePct(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return fallback;
  return parsed;
}

/**
 * Resolve the active refund policy from environment variables, falling back to
 * sensible defaults. All knobs are optional so the service works out of the box.
 *
 *   REFUND_FULL_REFUND_HOURS  — full-refund threshold in hours (default 168)
 *   REFUND_NO_REFUND_HOURS    — no-refund threshold in hours  (default 48)
 *   REFUND_PARTIAL_PCT        — partial refund fraction 0..1  (default 0.5)
 */
export function getRefundPolicyConfig(): RefundPolicyConfig {
  return {
    fullRefundHours: parseHours(process.env.REFUND_FULL_REFUND_HOURS, DEFAULT_REFUND_POLICY.fullRefundHours),
    noRefundHours: parseHours(process.env.REFUND_NO_REFUND_HOURS, DEFAULT_REFUND_POLICY.noRefundHours),
    partialRefundPct: parsePct(process.env.REFUND_PARTIAL_PCT, DEFAULT_REFUND_POLICY.partialRefundPct),
  };
}

/**
 * Determine which refund tier a cancellation belongs to, given the gap (in hours)
 * between cancellation time and check-in time.
 *
 * @throws Error if `hoursUntilCheckIn` is not a finite number.
 */
export function resolveRefundTier(hoursUntilCheckIn: number, config: RefundPolicyConfig): RefundTierId {
  if (!Number.isFinite(hoursUntilCheckIn)) {
    throw new Error('hoursUntilCheckIn must be a finite number');
  }

  if (hoursUntilCheckIn >= config.fullRefundHours) return 'full';
  if (hoursUntilCheckIn >= config.noRefundHours) return 'partial';
  return 'none';
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Compute the refund for a cancellation.
 *
 * @param params.totalPrice   - Booking total price (currency units).
 * @param params.checkIn      - Scheduled check-in (ISO string or Date).
 * @param params.cancelledAt  - When the cancellation happened (default: now).
 * @param params.config       - Override the active policy (mostly for tests).
 *
 * @returns RefundComputation with the tier, percentage, and absolute amount.
 * @throws Error if `checkIn` is missing/invalid or `totalPrice` is not finite.
 */
export function computeRefund(params: {
  totalPrice: number;
  checkIn: string | Date;
  cancelledAt?: Date | string;
  config?: RefundPolicyConfig;
}): RefundComputation {
  const { totalPrice, checkIn, cancelledAt, config } = params;

  if (!Number.isFinite(totalPrice)) {
    throw new Error('totalPrice must be a finite number');
  }

  const checkInDate = checkIn instanceof Date ? checkIn : new Date(checkIn);
  if (isNaN(checkInDate.getTime())) {
    throw new Error('checkIn must be a valid date');
  }

  const cancelDate = cancelledAt instanceof Date ? cancelledAt : new Date(cancelledAt ?? new Date());
  if (isNaN(cancelDate.getTime())) {
    throw new Error('cancelledAt must be a valid date');
  }

  const policy = config ?? getRefundPolicyConfig();
  const hoursUntilCheckIn = (checkInDate.getTime() - cancelDate.getTime()) / (1000 * 60 * 60);
  const tier = resolveRefundTier(hoursUntilCheckIn, policy);

  const refundPct = tier === 'full' ? 1 : tier === 'partial' ? policy.partialRefundPct : 0;
  const refundAmount = round2(totalPrice * refundPct);

  return {
    tier,
    refundPct,
    refundAmount,
    totalPrice,
    hoursUntilCheckIn,
    policy,
  };
}
