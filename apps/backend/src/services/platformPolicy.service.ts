/**
 * Platform Policy Service
 *
 * Single source of truth for all fees, refund tiers, escrow behaviour, and
 * risk disclosures that must be shown to users at listing / quote / booking /
 * payment / cancellation time and stored alongside each booking.
 *
 * VERSION BUMP RULE:
 *   Increment CURRENT_TERMS_VERSION whenever any of these values change in a
 *   way that materially affects a user's rights or obligations. Old bookings
 *   always retain the snapshot stored at booking-creation time; they are
 *   never retroactively updated.
 */

export const CURRENT_TERMS_VERSION = '2026-09-24.1';

// ── Fee structure ─────────────────────────────────────────────────────────────

/**
 * Platform fee charged to the tenant on top of the nightly rate.
 * Expressed as a fraction (0–1). 0.05 = 5 %.
 */
export const PLATFORM_FEE_PCT = 0.05;

/**
 * Network transaction fee range on Stellar for reference purposes only
 * (exact fee depends on ledger congestion, which Rentars does not control).
 */
export const STELLAR_FEE_RANGE_XLM = { min: 0.000001, max: 0.001 };

// ── Refund tiers (must stay in sync with refundPolicy.service.ts) ─────────────

export const REFUND_TIERS = [
  {
    id: 'full' as const,
    label: 'Full refund',
    hoursBeforeCheckIn: { gte: 168 }, // 7 days
    refundPct: 1.0,
    description: 'Cancel at least 7 days before check-in for a 100 % refund.',
  },
  {
    id: 'partial' as const,
    label: 'Partial refund (50 %)',
    hoursBeforeCheckIn: { gte: 48, lt: 168 }, // 2 – 7 days
    refundPct: 0.5,
    description: 'Cancel 2 – 6 days before check-in for a 50 % refund.',
  },
  {
    id: 'none' as const,
    label: 'No refund',
    hoursBeforeCheckIn: { lt: 48 }, // within 48 h
    refundPct: 0,
    description: 'Cancellations within 48 hours of check-in receive no refund.',
  },
] as const;

// ── Escrow behaviour ──────────────────────────────────────────────────────────

export const ESCROW_POLICY = {
  provider: 'TrustlessWork',
  currency: 'USDC' as const,
  network: 'Stellar' as const,
  holdDescription:
    'Your payment is held in a non-custodial smart-contract escrow on the Stellar blockchain. ' +
    'Funds are released to the host only after you confirm check-in (or after a dispute is resolved). ' +
    'Rentars never holds your funds directly.',
  disputeHoldDescription:
    'When a dispute is opened, funds remain locked in escrow until a Rentars moderator resolves the dispute. ' +
    'The resolution may award all funds to either party or split them according to the moderator\'s finding.',
};

// ── Network / blockchain risks ────────────────────────────────────────────────

export const BLOCKCHAIN_RISKS = [
  'Stellar transactions are irreversible. Verify all details before confirming.',
  'Wallet addresses are public on the Stellar ledger. Your address and transaction amounts are visible to anyone.',
  'USDC value is pegged to USD but not guaranteed by Rentars. Stablecoin de-peg risk exists.',
  'Smart contract bugs or Stellar network outages could delay or complicate escrow release. Rentars will work to resolve these issues but cannot guarantee specific timelines.',
  'You are responsible for securing your Freighter wallet and seed phrase. Lost access to your wallet means lost access to funds.',
] as const;

// ── Listing / host disclosures ────────────────────────────────────────────────

export const HOST_LISTING_DISCLOSURES = [
  'Listing your property creates an on-chain record on the Stellar blockchain that is publicly visible.',
  `Rentars charges a ${PLATFORM_FEE_PCT * 100} % platform fee deducted from each booking payment.`,
  'You must comply with local short-term rental regulations. Rentars does not verify legal compliance.',
  'Host earnings are settled in USDC to your connected Stellar wallet.',
  'Rentars may suspend listings that violate platform policies.',
] as const;

// ── Full policy snapshot ──────────────────────────────────────────────────────

export interface PolicySnapshot {
  version: string;
  effectiveDate: string;
  platformFeePct: number;
  refundTiers: typeof REFUND_TIERS;
  escrow: typeof ESCROW_POLICY;
  blockchainRisks: typeof BLOCKCHAIN_RISKS;
  hostDisclosures: typeof HOST_LISTING_DISCLOSURES;
  termsUrl: string;
  privacyUrl: string;
}

/**
 * Returns the current policy snapshot that should be:
 *   1. Shown to the user at booking / listing time.
 *   2. Stored on the booking record (as `terms_version`) at creation time.
 *
 * A later call with a *different* version string belongs to a different booking
 * and must not change the terms already accepted by an existing booking.
 */
export function getCurrentPolicySnapshot(): PolicySnapshot {
  const frontendUrl = process.env.FRONTEND_URL || 'https://rentars.app';
  return {
    version: CURRENT_TERMS_VERSION,
    effectiveDate: '2026-09-24',
    platformFeePct: PLATFORM_FEE_PCT,
    refundTiers: REFUND_TIERS,
    escrow: ESCROW_POLICY,
    blockchainRisks: BLOCKCHAIN_RISKS,
    hostDisclosures: HOST_LISTING_DISCLOSURES,
    termsUrl: `${frontendUrl}/terms`,
    privacyUrl: `${frontendUrl}/privacy`,
  };
}
