/**
 * Service layer for the Booking Soroban contract.
 *
 * Unlike the low-level BookingClient (which only builds XDR operations),
 * these functions prepare, sign, and submit full transactions using the
 * server admin keypair, and poll for on-chain confirmation.
 */

import {
  Contract,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import {
  BOOKING_CONTRACT_ID,
  NETWORK_PASSPHRASE,
  STELLAR_SOURCE_ACCOUNT,
} from './config.js';
import {
  getSorobanServer,
  simulateReadOnly,
  submitAndWait,
} from './soroban.js';
import { buildPrepareAndSign, extractReturnValue } from './transactionUtils.js';
import { ContractError } from './errors.js';
import type { BookingStatus, EscrowStatus } from './types.js';

/**
 * Escrow state ownership (Issue 116)
 * ----------------------------------
 * The Booking contract is the single authority for escrow state. The following
 * fields are contract-authoritative and MUST NOT be written from off-chain code
 * without a verified on-chain event backing the transition:
 *
 *   - `escrow_status`  — only moves via fund_escrow / resolve_dispute / refund
 *   - `status`         — terminal states (COMPLETED / CANCELLED / REFUNDED) are
 *                        only reachable through contract-authorized calls
 *   - `total_price`    — set at create_booking, immutable afterwards
 *   - `property_owner` / `tenant` — set at create_booking, immutable
 *
 * Everything else (provider references, Trustless Work escrow IDs, sync
 * bookkeeping) is recorded off-chain only and is never authoritative. Off-chain
 * actors may record a *pending* transition, but a terminal paid/refunded state
 * requires verified on-chain evidence. When on-chain and provider state
 * disagree, callers receive an `EscrowStateDisagreementError` rather than a
 * silently resolved value.
 */

/** Maximum number of bookings returned by a single paged read. */
export const MAX_BOOKING_PAGE_SIZE = 50;

/** Default page size used when the caller does not specify one. */
export const DEFAULT_BOOKING_PAGE_SIZE = 20;

/**
 * A single page of bookings plus the cursor needed to fetch the next page.
 * `nextCursor` is `null` when the caller has reached the end of the collection.
 */
export interface BookingPage {
  bookings: OnChainBooking[];
  nextCursor: bigint | null;
}

/** Shape of a booking record as returned by the contract. */
export interface OnChainBooking {
  id: bigint;
  status: BookingStatus;
  escrow_status: EscrowStatus;
  property_owner: string;
  tenant: string;
  total_price: bigint;
}

/**
 * Verified evidence that a terminal escrow transition happened on-chain.
 * Produced by inspecting a confirmed transaction's events; never constructed
 * from an unauthenticated callback or provider webhook.
 */
export interface VerifiedEscrowEvidence {
  /** On-chain booking ID the event refers to. */
  bookingId: bigint;
  /** Terminal escrow status asserted by the verified event. */
  escrowStatus: EscrowStatus;
  /** Amount (USDC stroops) asserted by the verified event. */
  amount: bigint;
  /** Ledger sequence in which the event was emitted. */
  ledger: number;
  /** Transaction hash of the confirmed transaction. */
  txHash: string;
}

/** Raised when on-chain and provider escrow state disagree. */
export class EscrowStateDisagreementError extends ContractError {
  constructor(
    public readonly bookingId: bigint,
    public readonly onChainStatus: EscrowStatus,
    public readonly providerStatus: string,
  ) {
    super(
      `Escrow state disagreement for booking ${bookingId}: ` +
        `on-chain=${onChainStatus}, provider=${providerStatus}. ` +
        'Refusing to resolve silently — manual reconciliation required.',
      'escrow_state_disagreement',
    );
    this.name = 'EscrowStateDisagreementError';
  }
}

/** Raised when a terminal transition lacks verified on-chain evidence. */
export class UnverifiedEscrowTransitionError extends ContractError {
  constructor(bookingId: bigint, reason: string) {
    super(
      `Refusing terminal escrow transition for booking ${bookingId}: ${reason}`,
      'unverified_escrow_transition',
    );
    this.name = 'UnverifiedEscrowTransitionError';
  }
}

function requireContractId(): void {
  if (!BOOKING_CONTRACT_ID) {
    throw new ContractError(
      'BOOKING_CONTRACT_ID environment variable is not set — ' +
        'configure it with a valid Soroban contract address before using booking operations',
    );
  }
}

function clampPageSize(pageSize: number | undefined): number {
  if (pageSize === undefined) return DEFAULT_BOOKING_PAGE_SIZE;
  if (!Number.isFinite(pageSize) || pageSize <= 0) {
    throw new ContractError(
      `Invalid page size ${pageSize}: must be a positive integer`,
      'invalid_page_size',
    );
  }
  return Math.min(Math.floor(pageSize), MAX_BOOKING_PAGE_SIZE);
}

function isTerminalEscrowStatus(status: EscrowStatus): boolean {
  return status === 'Released' || status === 'Refunded';
}

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * Check whether a property is available for the given date range.
 *
 * Dates are passed as Unix timestamps (seconds).
 *
 * @param propertyId - On-chain u64 property ID
 * @param startDate - Check-in as Unix timestamp (seconds)
 * @param endDate - Check-out as Unix timestamp (seconds)
 * @returns true if the property is available, false if already booked
 * @throws ContractError if BOOKING_CONTRACT_ID is not configured or the call fails
 */
export async function checkAvailability(
  propertyId: bigint,
  startDate: bigint,
  endDate: bigint,
): Promise<boolean> {
  requireContractId();

  const server = getSorobanServer();
  const contract = new Contract(BOOKING_CONTRACT_ID);

  const sourceAccount = await server.getAccount(STELLAR_SOURCE_ACCOUNT);
  const tx = new TransactionBuilder(sourceAccount, {
    fee: '100',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      contract.call(
        'check_availability',
        nativeToScVal(propertyId, { type: 'u64' }),
        nativeToScVal(startDate, { type: 'u64' }),
        nativeToScVal(endDate, { type: 'u64' }),
      ),
    )
    .setTimeout(30)
    .build();

  const retval = await simulateReadOnly(server, tx, 'check_availability');
  return scValToNative(retval) as boolean;
}

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Create an on-chain booking record and return the assigned on-chain booking ID.
 *
 * @param propertyId - On-chain u64 property ID.
 * @param userId - Stellar address of the tenant.
 * @param startDate - Check-in as Unix timestamp (seconds).
 * @param endDate - Check-out as Unix timestamp (seconds).
 * @param totalPrice - Total price in USDC stroops (i128).
 */
export async function createBookingOnChain(
  propertyId: bigint,
  userId: string,
  startDate: bigint,
  endDate: bigint,
  totalPrice: bigint,
): Promise<bigint> {
  requireContractId();

  const server = getSorobanServer();
  const contract = new Contract(BOOKING_CONTRACT_ID);

  const op = contract.call(
    'create_booking',
    nativeToScVal(userId, { type: 'address' }),
    nativeToScVal(propertyId, { type: 'u64' }),
    nativeToScVal(startDate, { type: 'u64' }),
    nativeToScVal(endDate, { type: 'u64' }),
    nativeToScVal(totalPrice, { type: 'i128' }),
  );

  const tx = await buildPrepareAndSign(server, [op]);
  const response = await submitAndWait(server, tx);

  const returnedId = extractReturnValue(response);
  if (returnedId === undefined) {
    throw new ContractError(
      'create_booking returned no value',
      'create_booking',
    );
  }

  return BigInt(returnedId as number | string);
}

/**
 * Cancel an existing on-chain booking.
 *
 * @param bookingId - On-chain u64 booking ID.
 * @param callerAddress - Stellar address of the caller (tenant or admin).
 */
export async function cancelBookingOnChain(
  bookingId: bigint,
  callerAddress: string,
): Promise<void> {
  requireContractId();

  const server = getSorobanServer();
  const contract = new Contract(BOOKING_CONTRACT_ID);

  const op = contract.call(
    'cancel_booking',
    nativeToScVal(callerAddress, { type: 'address' }),
    nativeToScVal(bookingId, { type: 'u64' }),
  );

  const tx = await buildPrepareAndSign(server, [op]);
  await submitAndWait(server, tx);
}

/**
 * Update the status of an on-chain booking.
 *
 * @param bookingId - On-chain u64 booking ID.
 * @param newStatus - Target BookingStatus.
 * @param callerAddress - Stellar address of the caller (admin).
 */
export async function updateBookingStatusOnChain(
  bookingId: bigint,
  newStatus: BookingStatus,
  callerAddress: string,
): Promise<void> {
  requireContractId();

  const server = getSorobanServer();
  const contract = new Contract(BOOKING_CONTRACT_ID);

  const op = contract.call(
    'update_status',
    nativeToScVal(callerAddress, { type: 'address' }),
    nativeToScVal(bookingId, { type: 'u64' }),
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(newStatus)]),
  );

  const tx = await buildPrepareAndSign(server, [op]);
  await submitAndWait(server, tx);
}

// ─── Escrow Operations ─────────────────────────────────────────────────────────

/**
 * Set the USDC token contract address for on-chain escrow.
 *
 * @param tokenAddress - Address of the USDC Soroban token contract.
 * @param callerAddress - Stellar address of the admin caller.
 */
export async function setTokenAddressOnChain(
  tokenAddress: string,
  callerAddress: string,
): Promise<void> {
  requireContractId();

  const server = getSorobanServer();
  const contract = new Contract(BOOKING_CONTRACT_ID);

  const op = contract.call(
    'set_token_address',
    nativeToScVal(callerAddress, { type: 'address' }),
    nativeToScVal(tokenAddress, { type: 'address' }),
  );

  const tx = await buildPrepareAndSign(server, [op]);
  await submitAndWait(server, tx);
}

/**
 * Fund the escrow for a booking by transferring USDC from the tenant to
 * the contract. The tenant must authorize this transaction.
 *
 * @param tenant - Stellar address of the tenant (must authorize).
 * @param bookingId - On-chain u64 booking ID.
 */
export async function fundEscrowOnChain(
  tenant: string,
  bookingId: bigint,
): Promise<void> {
  requireContractId();

  const server = getSorobanServer();
  const contract = new Contract(BOOKING_CONTRACT_ID);

  const op = contract.call(
    'fund_escrow',
    nativeToScVal(tenant, { type: 'address' }),
    nativeToScVal(bookingId, { type: 'u64' }),
  );

  const tx = await buildPrepareAndSign(server, [op]);
  await submitAndWait(server, tx);
}

/**
 * Dispute a funded booking. Only the tenant may start a dispute.
 *
 * @param tenant - Stellar address of the tenant (must authorize).
 * @param bookingId - On-chain u64 booking ID.
 */
export async function disputeBookingOnChain(
  tenant: string,
  bookingId: bigint,
): Promise<void> {
  requireContractId();

  const server = getSorobanServer();
  const contract = new Contract(BOOKING_CONTRACT_ID);

  const op = contract.call(
    'dispute_booking',
    nativeToScVal(tenant, { type: 'address' }),
    nativeToScVal(bookingId, { type: 'u64' }),
  );

  const tx = await buildPrepareAndSign(server, [op]);
  await submitAndWait(server, tx);
}

/**
 * Resolve a disputed booking. Admin decides whether to release escrowed
 * funds to the property owner (true) or refund the tenant (false).
 *
 * @param callerAddress - Stellar address of the admin caller.
 * @param bookingId - On-chain u64 booking ID.
 * @param releaseToOwner - true to release to owner, false to refund tenant.
 */
export async function resolveDisputeOnChain(
  callerAddress: string,
  bookingId: bigint,
  releaseToOwner: boolean,
): Promise<void> {
  requireContractId();

  const server = getSorobanServer();
  const contract = new Contract(BOOKING_CONTRACT_ID);

  const op = contract.call(
    'resolve_dispute',
    nativeToScVal(callerAddress, { type: 'address' }),
    nativeToScVal(bookingId, { type: 'u64' }),
    nativeToScVal(releaseToOwner, { type: 'bool' }),
  );

  const tx = await buildPrepareAndSign(server, [op]);
  await submitAndWait(server, tx);
}

/**
 * Get the configured USDC token contract address.
 *
 * @returns The token contract address.
 */
export async function getTokenAddressOnChain(): Promise<string> {
  requireContractId();

  const server = getSorobanServer();
  const contract = new Contract(BOOKING_CONTRACT_ID);

  const sourceAccount = await server.getAccount(STELLAR_SOURCE_ACCOUNT);
  const tx = new TransactionBuilder(sourceAccount, {
    fee: '100',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call('get_token_address'))
    .setTimeout(30)
    .build();

  const retval = await simulateReadOnly(server, tx, 'get_token_address');
  return scValToNative(retval) as string;
}

/**
 * Read the escrow status for a booking.
 *
 * @param bookingId - On-chain u64 booking ID.
 * @returns The booking (including escrow_status field).
 */
export async function getBookingWithEscrow(bookingId: bigint): Promise<{
  id: bigint;
  status: BookingStatus;
  escrow_status: EscrowStatus;
  property_owner: string;
  tenant: string;
  total_price: bigint;
}> {
  requireContractId();

  const server = getSorobanServer();
  const contract = new Contract(BOOKING_CONTRACT_ID);

  const sourceAccount = await server.getAccount(STELLAR_SOURCE_ACCOUNT);
  const tx = new TransactionBuilder(sourceAccount, {
    fee: '100',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      contract.call(
        'get_booking',
        nativeToScVal(bookingId, { type: 'u64' }),
      ),
    )
    .setTimeout(30)
    .build();

  const retval = await simulateReadOnly(server, tx, 'get_booking');
  return scValToNative(retval) as OnChainBooking;
}

// ─── Paged Reads ───────────────────────────────────────────────────────────────

/**
 * Fetch a bounded page of bookings using keyset (cursor) pagination.
 *
 * The contract exposes `get_bookings_page(cursor, limit)` where `cursor` is the
 * last booking ID already returned (exclusive lower bound) and `limit` is
 * capped at {@link MAX_BOOKING_PAGE_SIZE}. Ordering is deterministic ascending
 * by booking ID, so clients can walk the full history without duplicates or
 * gaps by passing `nextCursor` back in until it is `null`.
 *
 * @param cursor - Last seen booking ID, or `null` to start from the beginning.
 * @param pageSize - Requested page size (clamped to MAX_BOOKING_PAGE_SIZE).
 */
export async function getBookingsPage(
  cursor: bigint | null = null,
  pageSize?: number,
): Promise<BookingPage> {
  requireContractId();

  const limit = clampPageSize(pageSize);
  const server = getSorobanServer();
  const contract = new Contract(BOOKING_CONTRACT_ID);

  const sourceAccount = await server.getAccount(STELLAR_SOURCE_ACCOUNT);
  const tx = new TransactionBuilder(sourceAccount, {
    fee: '100',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      contract.call(
        'get_bookings_page',
        cursor === null
          ? xdr.ScVal.scvVoid()
          : nativeToScVal(cursor, { type: 'u64' }),
        nativeToScVal(limit, { type: 'u32' }),
      ),
    )
    .setTimeout(30)
    .build();

  const retval = await simulateReadOnly(server, tx, 'get_bookings_page');
  const native = scValToNative(retval) as {
    bookings: OnChainBooking[];
    next_cursor: bigint | null | undefined;
  };

  const bookings = native.bookings ?? [];
  if (bookings.length > limit) {
    throw new ContractError(
      `get_bookings_page returned ${bookings.length} records, exceeding the ` +
        `requested limit of ${limit}`,
      'page_size_exceeded',
    );
  }

  const nextCursor =
    native.next_cursor === undefined || native.next_cursor === null
      ? null
      : BigInt(native.next_cursor);

  return { bookings, nextCursor };
}

/**
 * Fetch every booking by walking bounded pages. Intended for background
 * reconciliation jobs, not for request-path reads. Callers should prefer
 * {@link getBookingsPage} when they only need a single page.
 *
 * @param pageSize - Requested page size (clamped to MAX_BOOKING_PAGE_SIZE).
 * @param maxPages - Safety bound on the number of pages fetched.
 */
export async function getAllBookingsPaged(
  pageSize?: number,
  maxPages = 1000,
): Promise<OnChainBooking[]> {
  const all: OnChainBooking[] = [];
  let cursor: bigint | null = null;
  let pages = 0;

  do {
    const page = await getBookingsPage(cursor, pageSize);
    all.push(...page.bookings);
    cursor = page.nextCursor;
    pages += 1;
    if (pages >= maxPages && cursor !== null) {
      throw new ContractError(
        `getAllBookingsPaged exceeded maxPages=${maxPages}; ` +
          'the collection may be larger than expected',
        'pagination_limit_exceeded',
      );
    }
  } while (cursor !== null);

  return all;
}

// ─── Verified Escrow Transitions ──────────────────────────────────────────────

/**
 * Assert that a terminal escrow transition is backed by verified on-chain
 * evidence for the correct booking and amount. This is the only sanctioned way
 * for off-chain code to record a paid/refunded outcome.
 *
 * @throws UnverifiedEscrowTransitionError when evidence is missing or mismatched.
 */
export function assertVerifiedEscrowEvidence(
  bookingId: bigint,
  expectedStatus: EscrowStatus,
  expectedAmount: bigint,
  evidence: VerifiedEscrowEvidence | null | undefined,
): asserts evidence is VerifiedEscrowEvidence {
  if (!evidence) {
    throw new UnverifiedEscrowTransitionError(
      bookingId,
      'no verified on-chain evidence supplied',
    );
  }
  if (evidence.bookingId !== bookingId) {
    throw new UnverifiedEscrowTransitionError(
      bookingId,
      `evidence refers to booking ${evidence.bookingId}`,
    );
  }
  if (evidence.escrowStatus !== expectedStatus) {
    throw new UnverifiedEscrowTransitionError(
      bookingId,
      `evidence status ${evidence.escrowStatus} does not match expected ${expectedStatus}`,
    );
  }
  if (evidence.amount !== expectedAmount) {
    throw new UnverifiedEscrowTransitionError(
      bookingId,
      `evidence amount ${evidence.amount} does not match expected ${expectedAmount}`,
    );
  }
  if (!evidence.txHash || evidence.ledger <= 0) {
    throw new UnverifiedEscrowTransitionError(
      bookingId,
      'evidence lacks a confirmed transaction hash or ledger',
    );
  }
}

/**
 * Reconcile on-chain escrow state against a provider-reported status.
 *
 * Returns the contract-authoritative booking when the two agree. When they
 * disagree, throws {@link EscrowStateDisagreementError} so the mismatch is
 * surfaced rather than silently resolved.
 *
 * @param bookingId - On-chain u64 booking ID.
 * @param providerStatus - Status reported by the off-chain provider.
 */
export async function reconcileEscrowState(
  bookingId: bigint,
  providerStatus: string,
): Promise<OnChainBooking> {
  const booking = await getBookingWithEscrow(bookingId);

  const normalizedProvider = providerStatus.toLowerCase();
  const onChain = booking.escrow_status;
  const agrees =
    (onChain === 'Released' && normalizedProvider === 'released') ||
    (onChain === 'Refunded' && normalizedProvider === 'refunded') ||
    (onChain === 'Funded' && normalizedProvider === 'funded') ||
    (onChain === 'Pending' && normalizedProvider === 'pending') ||
    (onChain === 'Disputed' && normalizedProvider === 'disputed');

  if (!agrees) {
    throw new EscrowStateDisagreementError(
      bookingId,
      onChain,
      providerStatus,
    );
  }

  return booking;
}

/**
 * Record a terminal escrow outcome off-chain, gated on verified on-chain
 * evidence. The contract remains the authority; this only mirrors a state that
 * the contract has already committed.
 *
 * @throws UnverifiedEscrowTransitionError when evidence is missing or invalid.
 * @throws EscrowStateDisagreementError when the contract has not reached the
 *   asserted terminal state.
 */
export async function recordVerifiedTerminalEscrow(
  bookingId: bigint,
  expectedStatus: Extract<EscrowStatus, 'Released' | 'Refunded'>,
  expectedAmount: bigint,
  evidence: VerifiedEscrowEvidence | null | undefined,
): Promise<OnChainBooking> {
  assertVerifiedEscrowEvidence(
    bookingId,
    expectedStatus,
    expectedAmount,
    evidence,
  );

  const booking = await getBookingWithEscrow(bookingId);
  if (!isTerminalEscrowStatus(booking.escrow_status)) {
    throw new EscrowStateDisagreementError(
      bookingId,
      booking.escrow_status,
      expectedStatus,
    );
  }
  if (booking.escrow_status !== expectedStatus) {
    throw new EscrowStateDisagreementError(
      bookingId,
      booking.escrow_status,
      expectedStatus,
    );
  }
  if (booking.total_price !== expectedAmount) {
    throw new UnverifiedEscrowTransitionError(
      bookingId,
      `on-chain total_price ${booking.total_price} does not match evidence amount ${expectedAmount}`,
    );
  }

  return booking;
}
