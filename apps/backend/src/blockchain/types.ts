/**
 * Shared TypeScript types derived from the Soroban contract ABIs.
 *
 * These types mirror the on-chain structs and enums defined in:
 *   - apps/contracts/booking_abi.json
 *   - apps/contracts/property_listing_abi.json
 *   - apps/contracts/review_abi.json
 *
 * Keep in sync with the ABI files whenever contracts are updated.
 */

import type { xdr } from '@stellar/stellar-sdk';

// ─── Property Listing Types ───────────────────────────────────────────────────

/** Mirrors ListingStatus enum in property_listing_abi.json */
export type ListingStatus = 'Active' | 'Inactive' | 'Rented';

/** Mirrors PropertyListing struct in property_listing_abi.json */
export interface PropertyListing {
  id: bigint;
  owner: string; // Stellar address
  title: string;
  description: string;
  /** Nightly price in USDC stroops (1 USDC = 10_000_000 stroops) */
  price_per_night: bigint;
  status: ListingStatus;
}

// ─── Booking Types ────────────────────────────────────────────────────────────

/** Mirrors BookingStatus enum in booking_abi.json */
export type BookingStatus =
  | 'Pending'
  | 'Confirmed'
  | 'Cancelled'
  | 'Completed'
  | 'Disputed';

/** Mirrors EscrowStatus enum in booking_abi.json */
export type EscrowStatus =
  | 'NotFunded'
  | 'Funded'
  | 'Released'
  | 'Refunded';

/** Mirrors Booking struct in booking_abi.json */
export interface Booking {
  id: bigint;
  property_id: bigint;
  tenant: string; // Stellar address
  property_owner: string; // Stellar address
  /** Unix timestamp (seconds) */
  check_in: bigint;
  /** Unix timestamp (seconds) */
  check_out: bigint;
  /** Total price in USDC stroops */
  total_price: bigint;
  status: BookingStatus;
  /** Off-chain escrow reference. Empty string until set by admin. */
  escrow_id: string;
  /** On-chain escrow status */
  escrow_status: EscrowStatus;
}

// ─── Review Types ─────────────────────────────────────────────────────────────

/** Mirrors Review struct in review_abi.json */
export interface Review {
  id: bigint;
  reviewee: string; // Stellar address
  reviewer: string; // Stellar address
  /** Rating value between 1 and 5 inclusive */
  rating: number;
  comment: string;
  /** Ledger timestamp at submission time (Unix seconds) */
  timestamp: bigint;
}

// ─── Input Parameter Types ────────────────────────────────────────────────────

/** Parameters for PropertyListingClient.createListing() */
export interface CreateListingParams {
  owner: string;
  title: string;
  description: string;
  price_per_night: bigint;
}

/** Parameters for PropertyListingClient.updateListing() */
export interface UpdateListingParams {
  caller: string;
  id: bigint;
  title: string;
  description: string;
  price_per_night: bigint;
}

/** Parameters for BookingClient.createBooking() */
export interface CreateBookingParams {
  tenant: string;
  property_id: bigint;
  check_in: bigint;
  check_out: bigint;
  total_price: bigint;
}

/** Parameters for ReviewClient.submitReview() */
export interface SubmitReviewParams {
  reviewer: string;
  reviewee: string;
  rating: number;
  comment: string;
}

// ─── Escrow Types ─────────────────────────────────────────────────────────────

/** Parameters for funding an escrow */
export interface FundEscrowParams {
  tenant: string;
  booking_id: bigint;
}

/** Parameters for disputing a booking */
export interface DisputeBookingParams {
  tenant: string;
  booking_id: bigint;
}

/** Parameters for resolving a dispute */
export interface ResolveDisputeParams {
  caller: string;
  booking_id: bigint;
  release_to_owner: boolean;
}

// ─── Pagination Types ─────────────────────────────────────────────────────────

/**
 * Maximum number of records a single contract page may return.
 *
 * Chosen to stay well within Soroban CPU/memory and ledger-entry read limits
 * when a page of structs is decoded and returned in one invocation. Clients
 * must never request more than this per call; the contract clamps larger
 * requests to this value.
 */
export const MAX_PAGE_SIZE = 50;

/** Default page size used by clients when no explicit limit is supplied. */
export const DEFAULT_PAGE_SIZE = 20;

/**
 * Opaque keyset cursor for bounded contract reads.
 *
 * Cursors are stable across pages: they encode the last-seen sort key (the
 * record id) so that pages can be fetched without duplicates or gaps even if
 * records are added between requests. Treat the value as opaque; only the
 * contract that issued it may interpret it.
 */
export type ContractCursor = string;

/** Parameters for any paged contract read. */
export interface PageParams {
  /** Cursor returned by a previous page. Omit (or pass null) for the first page. */
  cursor?: ContractCursor | null;
  /** Requested page size. Clamped to [1, MAX_PAGE_SIZE] by the contract. */
  limit?: number;
}

/** A single bounded page of contract records. */
export interface Page<T> {
  /** Records in deterministic ascending id order. */
  items: T[];
  /** Cursor for the next page, or null when this is the last page. */
  next_cursor: ContractCursor | null;
  /** Whether more records exist after this page. */
  has_more: boolean;
}

/** Paged read of bookings, optionally filtered by tenant or property. */
export interface BookingPageParams extends PageParams {
  /** Restrict to bookings for this tenant address. */
  tenant?: string;
  /** Restrict to bookings for this property id. */
  property_id?: bigint;
}

/** Paged read of property listings, optionally filtered by owner. */
export interface ListingPageParams extends PageParams {
  /** Restrict to listings owned by this address. */
  owner?: string;
}

/** Paged read of reviews, optionally filtered by reviewee or reviewer. */
export interface ReviewPageParams extends PageParams {
  /** Restrict to reviews about this address. */
  reviewee?: string;
  /** Restrict to reviews authored by this address. */
  reviewer?: string;
}

// ─── Escrow Authority & Evidence Types ────────────────────────────────────────

/**
 * Authority responsible for a given escrow state field.
 *
 * - `contract`: the booking contract is the sole writer; off-chain actors
 *   cannot change it without a verified on-chain transaction.
 * - `provider`: the escrow provider (e.g. Trustless Work) is authoritative;
 *   the contract mirrors it only after verifying provider evidence.
 * - `offchain`: recorded by backend services for display only; never used to
 *   derive a terminal paid/refunded state.
 */
export type EscrowFieldAuthority = 'contract' | 'provider' | 'offchain';

/** Documented authority of each escrow-related field. */
export interface EscrowFieldAuthorityRecord {
  /** Field name, e.g. "escrow_status" or "escrow_id". */
  field: string;
  /** Who may authoritatively write this field. */
  authority: EscrowFieldAuthority;
  /** Human-readable description of the transition rules. */
  description: string;
}

/**
 * Kind of evidence required to move a booking's escrow to a terminal state.
 * Terminal states are `Released` and `Refunded`.
 */
export type EscrowEvidenceKind =
  | 'on_chain_tx'
  | 'provider_webhook'
  | 'provider_query';

/**
 * Verified evidence backing an escrow state transition.
 *
 * Evidence must be authenticated (signed webhook or on-chain tx hash) and
 * bound to the exact booking, amount, and asset before it is accepted.
 */
export interface EscrowEvidence {
  kind: EscrowEvidenceKind;
  /** Booking id the evidence applies to. */
  booking_id: bigint;
  /** Escrow reference (provider id or contract escrow id). */
  escrow_id: string;
  /** Amount in USDC stroops the evidence attests to. */
  amount: bigint;
  /** Asset identifier, e.g. "USDC". */
  asset: string;
  /** On-chain transaction hash, when the evidence is on-chain. */
  tx_hash?: string;
  /** Provider event id, when the evidence is a provider callback. */
  provider_event_id?: string;
  /** Unix timestamp (seconds) when the evidence was observed. */
  observed_at: number;
}

/**
 * Result of verifying escrow evidence against the booking contract state.
 *
 * A `pending` result means the transition is recorded but not terminal; a
 * `mismatch` result surfaces on-chain/provider disagreement and must not be
 * silently resolved.
 */
export type EscrowVerificationOutcome =
  | 'accepted'
  | 'pending'
  | 'rejected'
  | 'mismatch';

/** Outcome of verifying a single piece of escrow evidence. */
export interface EscrowVerificationResult {
  outcome: EscrowVerificationOutcome;
  /** Booking id the verification applies to. */
  booking_id: bigint;
  /** Machine-readable reason code, e.g. "wrong_amount", "replay", "forged". */
  reason?: string;
  /** Human-readable explanation safe to log and display. */
  message: string;
  /** Evidence that was verified, echoed for auditability. */
  evidence?: EscrowEvidence;
}

// ─── Simulation & Fee Estimation Types ────────────────────────────────────────

/**
 * A single diagnostic entry surfaced by Soroban RPC simulation.
 * Mirrors the shape of `DiagnosticEvent` / error entries returned by
 * `simulateTransaction`, normalized for safe consumption by the client.
 */
export interface SimulationDiagnostic {
  /** Machine-readable diagnostic code, e.g. "auth", "contract", "budget". */
  code: string;
  /** Human-readable message safe to display to end users. */
  message: string;
  /** Optional contract error code when the failure originated on-chain. */
  contract_error_code?: number;
  /** Whether the caller can recover by adjusting inputs and retrying. */
  recoverable: boolean;
}

/** Estimated resource usage returned by simulation. */
export interface SimulationResources {
  /** CPU instructions consumed by the simulated invocation. */
  cpu_instructions: bigint;
  /** Memory bytes consumed by the simulated invocation. */
  memory_bytes: bigint;
  /** Number of ledger entries read during simulation. */
  read_bytes: bigint;
  /** Number of ledger entries written during simulation. */
  write_bytes: bigint;
}

/** Estimated fee breakdown for a simulated transaction. */
export interface FeeEstimate {
  /** Inclusion fee in stroops (1 XLM = 10_000_000 stroops). */
  inclusion_fee: bigint;
  /** Resource fee in stroops covering CPU, memory, and ledger I/O. */
  resource_fee: bigint;
  /** Total estimated fee in stroops (inclusion + resource). */
  total_fee: bigint;
  /** Asset used to pay the fee, e.g. "XLM" or "USDC". */
  fee_asset: string;
}

/** Result of simulating a Soroban transaction prior to signing. */
export interface SimulationResult {
  /** Whether the simulated transaction would succeed on-chain. */
  success: boolean;
  /** Estimated fee for the transaction. Present even on failure when available. */
  fee_estimate?: FeeEstimate;
  /** Estimated resource consumption. Present when simulation completed. */
  resources?: SimulationResources;
  /** Diagnostics describing failures or warnings. Empty when success is true. */
  diagnostics: SimulationDiagnostic[];
  /** Latest ledger sequence observed during simulation. */
  latest_ledger: number;
  /** Unix timestamp (seconds) when this simulation was produced. */
  simulated_at: number;
  /** Opaque cache key derived from the transaction intent. */
  intent_key: string;
}

/**
 * Cache entry for a short-lived simulation result keyed by transaction intent.
 * Invalidated when inputs change or the observed ledger advances.
 */
export interface SimulationCacheEntry {
  /** Cache key derived from the transaction intent. */
  intent_key: string;
  /** Cached simulation result. */
  result: SimulationResult;
  /** Ledger sequence at which the cached result was produced. */
  ledger: number;
  /** Unix timestamp (seconds) when the entry expires. */
  expires_at: number;
}

/** Inputs required to simulate a supported Soroban transaction. */
export interface SimulateTransactionParams {
  /** Base64-encoded unsigned transaction envelope XDR. */
  transaction_xdr: string;
  /** Optional pre-built auth entries to include in the simulation. */
  auth?: xdr.SorobanAuthorizationEntry[];
  /** Optional override for the ledger used during simulation. */
  ledger_override?: number;
}

// ─── ABI Compatibility Assertions ─────────────────────────────────────────────
//
// The assertions below are compile-time only (they emit no runtime code) and
// fail the TypeScript build if the shared types drift from the contract ABIs.
// Each assertion names the TypeScript type and the ABI file it is derived from
// so a regression points directly at the interface that changed.

/** Exact (mutual) assignability check between two types. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Fails to compile unless `T` is exactly `true`. */
type Assert<T extends true> = T;

/** Compile-time assertion that `A` and `B` are exactly the same type. */
type AssertExact<A, B, _Message extends string> = Assert<Exact<A, B>>;

/**
 * Enum variants as declared in `apps/contracts/booking_abi.json`.
 * Update this list together with the ABI and the `BookingStatus` union.
 */
type BookingStatusAbiVariants =
  | 'Pending'
  | 'Confirmed'
  | 'Cancelled'
  | 'Completed'
  | 'Disputed';

/**
 * Enum variants as declared in `apps/contracts/booking_abi.json`.
 * Update this list together with the ABI and the `EscrowStatus` union.
 */
type EscrowStatusAbiVariants =
  | 'NotFunded'
  | 'Funded'
  | 'Released'
  | 'Refunded';

/**
 * Enum variants as declared in `apps/contracts/property_listing_abi.json`.
 * Update this list together with the ABI and the `ListingStatus` union.
 */
type ListingStatusAbiVariants = 'Active' | 'Inactive' | 'Rented';

/**
 * Struct fields as declared in `apps/contracts/booking_abi.json` (`Booking`).
 * Update this list together with the ABI and the `Booking` interface.
 */
type BookingAbiFields = {
  id: bigint;
  property_id: bigint;
  tenant: string;
  property_owner: string;
  check_in: bigint;
  check_out: bigint;
  total_price: bigint;
  status: BookingStatus;
  escrow_id: string;
  escrow_status: EscrowStatus;
};

/**
 * Struct fields as declared in `apps/contracts/property_listing_abi.json`
 * (`PropertyListing`). Update this list together with the ABI and the
 * `PropertyListing` interface.
 */
type PropertyListingAbiFields = {
  id: bigint;
  owner: string;
  title: string;
  description: string;
  price_per_night: bigint;
  status: ListingStatus;
};

// Enum unions must match the ABI variants exactly (no missing/extra variants).
type _BookingStatusMatchesAbi = AssertExact<
  BookingStatus,
  BookingStatusAbiVariants,
  'BookingStatus must match enum variants in apps/contracts/booking_abi.json'
>;
type _EscrowStatusMatchesAbi = AssertExact<
  EscrowStatus,
  EscrowStatusAbiVariants,
  'EscrowStatus must match enum variants in apps/contracts/booking_abi.json'
>;
type _ListingStatusMatchesAbi = AssertExact<
  ListingStatus,
  ListingStatusAbiVariants,
  'ListingStatus must match enum variants in apps/contracts/property_listing_abi.json'
>;

// Struct interfaces must match the ABI field sets exactly.
type _BookingMatchesAbi = AssertExact<
  Booking,
  BookingAbiFields,
  'Booking must match struct fields in apps/contracts/booking_abi.json'
>;
type _PropertyListingMatchesAbi = AssertExact<
  PropertyListing,
  PropertyListingAbiFields,
  'PropertyListing must match struct fields in apps/contracts/property_listing_abi.json'
>;

/**
 * Runtime mirror of the compile-time assertions above. Import and call this in
 * tests to surface a descriptive failure naming the type and ABI source when
 * the shared types and contract ABIs diverge.
 */
export const ABI_COMPATIBILITY = {
  bookingStatus: {
    abi: 'apps/contracts/booking_abi.json',
    type: 'BookingStatus',
    variants: ['Pending', 'Confirmed', 'Cancelled', 'Completed', 'Disputed'] as const,
  },
  escrowStatus: {
    abi: 'apps/contracts/booking_abi.json',
    type: 'EscrowStatus',
    variants: ['NotFunded', 'Funded', 'Released', 'Refunded'] as const,
  },
  listingStatus: {
    abi: 'apps/contracts/property_listing_abi.json',
    type: 'ListingStatus',
    variants: ['Active', 'Inactive', 'Rented'] as const,
  },
  bookingFields: {
    abi: 'apps/contracts/booking_abi.json',
    type: 'Booking',
    fields: [
      'id',
      'property_id',
      'tenant',
      'property_owner',
      'check_in',
      'check_out',
      'total_price',
      'status',
      'escrow_id',
      'escrow_status',
    ] as const,
  },
  propertyListingFields: {
    abi: 'apps/contracts/property_listing_abi.json',
    type: 'PropertyListing',
    fields: [
      'id',
      'owner',
      'title',
      'description',
      'price_per_night',
      'status',
    ] as const,
  },
} as const;

/**
 * Asserts at runtime that the given enum value set matches the ABI variants
 * recorded in {@link ABI_COMPATIBILITY}. Throws an error naming the TypeScript
 * type and ABI source so a regression is easy to locate.
 */
export function assertEnumMatchesAbi(
  type: 'BookingStatus' | 'EscrowStatus' | 'ListingStatus',
  actual: readonly string[],
): void {
  const expected =
    type === 'BookingStatus'
      ? ABI_COMPATIBILITY.bookingStatus
      : type === 'EscrowStatus'
        ? ABI_COMPATIBILITY.escrowStatus
        : ABI_COMPATIBILITY.listingStatus;

  const expectedSet = new Set<string>(expected.variants);
  const actualSet = new Set<string>(actual);
  const missing = [...expectedSet].filter((v) => !actualSet.has(v));
  const extra = [...actualSet].filter((v) => !expectedSet.has(v));

  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `${type} does not match enum variants in ${expected.abi}` +
        (missing.length > 0 ? `; missing: ${missing.join(', ')}` : '') +
        (extra.length > 0 ? `; unexpected: ${extra.join(', ')}` : ''),
    );
  }
}

/**
 * Asserts at runtime that the given struct field names match the ABI fields
 * recorded in {@link ABI_COMPATIBILITY}. Throws an error naming the TypeScript
 * type and ABI source so a regression is easy to locate.
 */
export function assertStructMatchesAbi(
  type: 'Booking' | 'PropertyListing',
  actual: readonly string[],
): void {
  const expected =
    type === 'Booking'
      ? ABI_COMPATIBILITY.bookingFields
      : ABI_COMPATIBILITY.propertyListingFields;

  const expectedSet = new Set<string>(expected.fields);
  const actualSet = new Set<string>(actual);
  const missing = [...expectedSet].filter((f) => !actualSet.has(f));
  const extra = [...actualSet].filter((f) => !expectedSet.has(f));

  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `${type} does not match struct fields in ${expected.abi}` +
        (missing.length > 0 ? `; missing: ${missing.join(', ')}` : '') +
        (extra.length > 0 ? `; unexpected: ${extra.join(', ')}` : ''),
    );
  }
}
