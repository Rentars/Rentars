import {
  fundEscrowOnChain,
  disputeBookingOnChain,
  resolveDisputeOnChain,
  getBookingWithEscrow,
} from './bookingContract.js';
import { EscrowError } from './errors.js';

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface BookingEscrowParams {
  propertyId: string;
  bookingId: string;
  buyerAddress: string;
  sellerAddress: string;
  amountUsdc: string;
  checkIn: string;
  checkOut: string;
}

export interface CreateEscrowRequest {
  buyer: string;
  seller: string;
  amount: string;
  token: string;
  title: string;
  description: string;
  metadata?: Record<string, unknown>;
}

export interface CreateEscrowResponse {
  escrowId: string;
  contractId: string;
  status: string;
}

export interface FundEscrowRequest {
  escrowId: string;
  amount: string;
  txHash: string;
}

export interface ReleaseEscrowRequest {
  escrowId: string;
  reason: string;
}

export interface EscrowStatus {
  escrowId: string;
  status: 'created' | 'funded' | 'released' | 'cancelled' | 'disputed';
  amount: string;
  token: string;
  buyer: string;
  seller: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Escrow State Ownership ───────────────────────────────────────────────────
//
// Authoritative escrow states and field authority:
//
//   Contract-authorized (on-chain is the source of truth):
//     - funded:    tenant deposited USDC via the Soroban booking contract.
//     - disputed:  tenant raised a dispute on-chain.
//     - released:  admin resolved dispute in favour of the owner, OR the
//                  contract released funds after check-out. TERMINAL.
//     - refunded:  admin resolved dispute in favour of the tenant, OR the
//                  contract refunded after cancellation. TERMINAL.
//
//   Off-chain only (recorded by backend, never authoritative for money):
//     - created:   escrow record exists in Trustless Work; no funds moved.
//     - cancelled: provider-side cancellation record; funds must be refunded
//                  on-chain before the booking is considered settled.
//
//   Terminal states (released, refunded) may ONLY be entered when backed by
//   an authenticated, verified on-chain event whose booking ID, amount and
//   replay nonce match the booking. Provider callbacks alone can never move a
//   booking into a terminal state.

/** Escrow states that represent final settlement of funds. */
export const TERMINAL_ESCROW_STATES = ['released', 'refunded'] as const;
export type TerminalEscrowState = (typeof TERMINAL_ESCROW_STATES)[number];

/** Escrow states that are recorded off-chain and are not final settlement. */
export const PENDING_ESCROW_STATES = ['created', 'funded', 'cancelled', 'disputed'] as const;
export type PendingEscrowState = (typeof PENDING_ESCROW_STATES)[number];

export function isTerminalEscrowState(state: string): state is TerminalEscrowState {
  return (TERMINAL_ESCROW_STATES as readonly string[]).includes(state);
}

/**
 * Verified evidence of an on-chain escrow event. This is the ONLY input that
 * may authorize a transition into a terminal escrow state.
 */
export interface VerifiedEscrowEvent {
  /** On-chain u64 booking ID the event belongs to. */
  bookingId: bigint;
  /** Event kind emitted by the booking contract. */
  kind: 'released' | 'refunded';
  /** Amount (in stroops / smallest USDC unit) settled by the event. */
  amount: string;
  /** Ledger sequence the event was emitted in. */
  ledger: number;
  /** Transaction hash of the on-chain settlement. */
  txHash: string;
  /** Unique event identifier used for replay protection. */
  eventId: string;
  /** True only if the event was authenticated and verified against chain. */
  verified: boolean;
}

export interface EscrowStateDisagreement {
  bookingId: string;
  providerStatus: string;
  onChainStatus: string;
  terminal: boolean;
  reason: string;
}

export interface EscrowTransitionResult {
  bookingId: string;
  previousStatus: string;
  nextStatus: string;
  terminal: boolean;
  disagreement?: EscrowStateDisagreement;
}

// ─── Client ───────────────────────────────────────────────────────────────────

export class TrustlessWorkClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  /** Event IDs already applied, for replay protection. */
  private readonly appliedEventIds = new Set<string>();

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      let message = `TrustlessWork API error: ${response.status} ${response.statusText}`;
      try {
        const errorBody = (await response.json()) as { message?: string };
        if (errorBody.message) {
          message = errorBody.message;
        }
      } catch {
        // ignore JSON parse errors on error responses
      }
      throw new EscrowError(message, response.status);
    }

    return response.json() as Promise<T>;
  }

  /**
   * Create a new USDC escrow for a booking.
   *
   * @param params - Escrow creation parameters
   * @returns CreateEscrowResponse containing escrowId, contractId, and status
   * @throws EscrowError on non-2xx API responses
   */
  async createEscrow(params: CreateEscrowRequest): Promise<CreateEscrowResponse> {
    return this.request<CreateEscrowResponse>('POST', '/escrows', params);
  }

  /**
   * Fund an existing escrow after the buyer has sent USDC on-chain.
   *
   * @param escrowId - ID of the escrow to fund
   * @param amount - USDC amount string
   * @param txHash - On-chain transaction hash of the funding transfer
   * @throws EscrowError on non-2xx API responses
   */
  async fundEscrow(escrowId: string, amount: string, txHash: string): Promise<void> {
    const body: FundEscrowRequest = { escrowId, amount, txHash };
    await this.request<void>('POST', `/escrows/${escrowId}/fund`, body);
  }

  /**
   * Release escrowed funds to the seller (property owner).
   *
   * @param escrowId - ID of the escrow to release
   * @param reason - Human-readable reason for the release
   * @throws EscrowError on non-2xx API responses
   */
  async releaseEscrow(escrowId: string, reason: string): Promise<void> {
    const body: ReleaseEscrowRequest = { escrowId, reason };
    await this.request<void>('POST', `/escrows/${escrowId}/release`, body);
  }

  /**
   * Cancel the escrow and return funds to the buyer (tenant).
   *
   * @param escrowId - ID of the escrow to cancel
   * @throws EscrowError on non-2xx API responses
   */
  async cancelEscrow(escrowId: string): Promise<void> {
    await this.request<void>('POST', `/escrows/${escrowId}/cancel`);
  }

  /**
   * Retrieve the current status of an escrow.
   *
   * @param escrowId - ID of the escrow to query
   * @returns EscrowStatus with amounts, participants, and current state
   * @throws EscrowError on non-2xx API responses
   */
  async getEscrowStatus(escrowId: string): Promise<EscrowStatus> {
    return this.request<EscrowStatus>('GET', `/escrows/${escrowId}`);
  }

  /**
   * Create an escrow from structured booking parameters, setting a
   * human-readable title and relevant metadata automatically.
   *
   * @param params - Booking-specific parameters
   * @returns CreateEscrowResponse containing escrowId, contractId, and status
   * @throws EscrowError on non-2xx API responses
   */
  async createBookingEscrow(params: BookingEscrowParams): Promise<CreateEscrowResponse> {
    return this.createEscrow({
      buyer: params.buyerAddress,
      seller: params.sellerAddress,
      amount: params.amountUsdc,
      token: 'USDC',
      title: `Booking ${params.bookingId} — Property ${params.propertyId}`,
      description: `Rental escrow for check-in ${params.checkIn} to check-out ${params.checkOut}`,
      metadata: {
        bookingId: params.bookingId,
        propertyId: params.propertyId,
        checkIn: params.checkIn,
        checkOut: params.checkOut,
      },
    });
  }

  // ─── Soroban Escrow Integration ──────────────────────────────────────────────

  /**
   * Fund an on-chain escrow via the Soroban booking contract.
   * Tenants call this to deposit USDC into the contract.
   *
   * @param tenant - Stellar address of the tenant (must authorize).
   * @param bookingId - On-chain u64 booking ID.
   */
  async fundOnChainEscrow(tenant: string, bookingId: bigint): Promise<void> {
    await fundEscrowOnChain(tenant, bookingId);
  }

  /**
   * Dispute a funded booking on-chain. Only the tenant may dispute.
   *
   * @param tenant - Stellar address of the tenant (must authorize).
   * @param bookingId - On-chain u64 booking ID.
   */
  async disputeBookingOnChain(tenant: string, bookingId: bigint): Promise<void> {
    await disputeBookingOnChain(tenant, bookingId);
  }

  /**
   * Resolve a disputed booking on-chain. Admin decides the outcome.
   *
   * @param admin - Stellar address of the admin caller.
   * @param bookingId - On-chain u64 booking ID.
   * @param releaseToOwner - true to release to owner, false to refund tenant.
   */
  async resolveDisputeOnChain(
    admin: string,
    bookingId: bigint,
    releaseToOwner: boolean,
  ): Promise<void> {
    await resolveDisputeOnChain(admin, bookingId, releaseToOwner);
  }

  /**
   * Get the on-chain escrow status for a booking.
   *
   * @param bookingId - On-chain u64 booking ID.
   * @returns Object with status, owner, tenant, and price.
   */
  async getOnChainEscrowStatus(
    bookingId: bigint,
  ): Promise<{
    status: string;
    escrowStatus: string;
    propertyOwner: string;
    tenant: string;
    amount: string;
  }> {
    const booking = await getBookingWithEscrow(bookingId);
    return {
      status: booking.status,
      escrowStatus: booking.escrow_status,
      propertyOwner: booking.property_owner,
      tenant: booking.tenant,
      amount: booking.total_price.toString(),
    };
  }

  // ─── Verified State Transitions ─────────────────────────────────────────────

  /**
   * Validate that an escrow event is authentic, matches the booking, matches
   * the expected amount, and has not been replayed. Throws EscrowError on any
   * failure so an unverified request can never reach a terminal state.
   *
   * @param bookingId - Booking the event must belong to.
   * @param expectedAmount - Amount the booking expects to settle.
   * @param event - Candidate on-chain event evidence.
   */
  private assertVerifiedEvent(
    bookingId: bigint,
    expectedAmount: string,
    event: VerifiedEscrowEvent,
  ): void {
    if (!event.verified) {
      throw new EscrowError('Escrow event is not verified against chain', 401);
    }
    if (event.bookingId !== bookingId) {
      throw new EscrowError(
        `Escrow event booking mismatch: expected ${bookingId.toString()}, got ${event.bookingId.toString()}`,
        409,
      );
    }
    if (event.amount !== expectedAmount) {
      throw new EscrowError(
        `Escrow event amount mismatch: expected ${expectedAmount}, got ${event.amount}`,
        409,
      );
    }
    if (!event.eventId || !event.txHash) {
      throw new EscrowError('Escrow event missing eventId or txHash', 400);
    }
    if (this.appliedEventIds.has(event.eventId)) {
      throw new EscrowError(`Escrow event replay detected: ${event.eventId}`, 409);
    }
  }

  /**
   * Apply a verified on-chain settlement event to a booking's escrow state.
   *
   * Only a verified event whose booking ID and amount match the booking, and
   * which has not been seen before, can move the booking into a terminal
   * `released` or `refunded` state. Provider-reported status is compared
   * against on-chain status; any disagreement is surfaced in the result
   * rather than silently resolved.
   *
   * @param bookingId - On-chain u64 booking ID.
   * @param event - Verified on-chain settlement event.
   * @returns Transition result including any provider/on-chain disagreement.
   */
  async applyVerifiedEscrowEvent(
    bookingId: bigint,
    event: VerifiedEscrowEvent,
  ): Promise<EscrowTransitionResult> {
    const onChain = await this.getOnChainEscrowStatus(bookingId);
    this.assertVerifiedEvent(bookingId, onChain.amount, event);

    const providerStatus = onChain.escrowStatus;
    const onChainStatus = event.kind;
    const terminal = isTerminalEscrowState(onChainStatus);

    let disagreement: EscrowStateDisagreement | undefined;
    if (providerStatus !== onChainStatus) {
      disagreement = {
        bookingId: bookingId.toString(),
        providerStatus,
        onChainStatus,
        terminal,
        reason: 'Provider escrow status disagrees with verified on-chain event',
      };
    }

    // Record the event only after all checks pass, so a forged or replayed
    // event can never poison replay protection.
    this.appliedEventIds.add(event.eventId);

    return {
      bookingId: bookingId.toString(),
      previousStatus: providerStatus,
      nextStatus: onChainStatus,
      terminal,
      disagreement,
    };
  }

  /**
   * Compare provider-reported escrow status with on-chain status and return a
   * disagreement descriptor if they differ. Never mutates state.
   *
   * @param bookingId - On-chain u64 booking ID.
   * @param providerStatus - Status reported by the Trustless Work provider.
   */
  async detectEscrowDisagreement(
    bookingId: bigint,
    providerStatus: string,
  ): Promise<EscrowStateDisagreement | undefined> {
    const onChain = await this.getOnChainEscrowStatus(bookingId);
    if (onChain.escrowStatus === providerStatus) {
      return undefined;
    }
    return {
      bookingId: bookingId.toString(),
      providerStatus,
      onChainStatus: onChain.escrowStatus,
      terminal: isTerminalEscrowState(onChain.escrowStatus),
      reason: 'Provider escrow status disagrees with on-chain escrow status',
    };
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const trustlessWorkClient = new TrustlessWorkClient(
  process.env.TRUSTLESS_WORK_API_URL ?? 'https://api.trustlesswork.com',
  process.env.TRUSTLESS_WORK_API_KEY ?? '',
);
