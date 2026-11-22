export class BlockchainError extends Error {
  readonly code: string;

  constructor(message: string, code = 'BLOCKCHAIN_ERROR') {
    super(message);
    this.name = 'BlockchainError';
    this.code = code;
  }
}

export class ContractError extends BlockchainError {
  constructor(
    message: string,
    public readonly contractMethod?: string,
  ) {
    super(message, 'CONTRACT_ERROR');
    this.name = 'ContractError';
  }
}

export class TransactionError extends BlockchainError {
  constructor(
    message: string,
    public readonly txHash?: string,
  ) {
    super(message, 'TRANSACTION_ERROR');
    this.name = 'TransactionError';
  }
}

export class AvailabilityError extends BlockchainError {
  constructor(message: string) {
    super(message, 'AVAILABILITY_ERROR');
    this.name = 'AvailabilityError';
  }
}

export class EscrowError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'EscrowError';
  }
}

export interface SimulationDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly severity: 'error' | 'warning' | 'info';
  readonly contractMethod?: string;
  readonly recoverable: boolean;
}

export interface FeeEstimation {
  readonly baseFee: string;
  readonly resourceFee: string;
  readonly totalFee: string;
  readonly minResourceFee?: string;
  readonly maxResourceFee?: string;
  readonly currency: string;
}

export interface SimulationResult {
  readonly success: boolean;
  readonly fee: FeeEstimation;
  readonly diagnostics: readonly SimulationDiagnostic[];
  readonly ledger: number;
  readonly expiresAt: number;
}

export class SimulationError extends BlockchainError {
  constructor(
    message: string,
    public readonly diagnostics: readonly SimulationDiagnostic[] = [],
  ) {
    super(message, 'SIMULATION_ERROR');
    this.name = 'SimulationError';
  }
}

export class QuoteInvalidatedError extends BlockchainError {
  constructor(message = 'Quote changed; previous simulation is no longer valid') {
    super(message, 'QUOTE_INVALIDATED');
    this.name = 'QuoteInvalidatedError';
  }
}

/**
 * Cross-contract failure scenarios exercised by the integration test harness.
 * Each scenario maps to the interface or state invariant that regressed so
 * failures are attributable to a specific contract boundary.
 */
export type CrossContractFailureScenario =
  | 'missing_contract'
  | 'inactive_listing'
  | 'overlapping_reservation'
  | 'downstream_failure';

export interface CrossContractFailureContext {
  readonly scenario: CrossContractFailureScenario;
  readonly contractMethod?: string;
  readonly listingId?: string;
  readonly bookingId?: string;
  readonly cause?: unknown;
}

const CROSS_CONTRACT_FAILURE_CODES: Record<CrossContractFailureScenario, string> = {
  missing_contract: 'MISSING_CONTRACT',
  inactive_listing: 'INACTIVE_LISTING',
  overlapping_reservation: 'OVERLAPPING_RESERVATION',
  downstream_failure: 'DOWNSTREAM_FAILURE',
};

const CROSS_CONTRACT_FAILURE_MESSAGES: Record<CrossContractFailureScenario, string> = {
  missing_contract: 'Property listing contract is not deployed or not initialized',
  inactive_listing: 'Listing is not eligible for booking (inactive or unavailable)',
  overlapping_reservation: 'Reservation overlaps an existing booking for this listing',
  downstream_failure: 'Downstream contract call failed; booking was rolled back',
};

/**
 * Error raised when a cross-contract call fails. The `code` identifies the
 * regressed interface/invariant and `contractMethod` identifies the boundary.
 */
export class CrossContractError extends BlockchainError {
  constructor(
    public readonly scenario: CrossContractFailureScenario,
    public readonly contractMethod?: string,
    message?: string,
  ) {
    super(
      message ?? CROSS_CONTRACT_FAILURE_MESSAGES[scenario],
      CROSS_CONTRACT_FAILURE_CODES[scenario],
    );
    this.name = 'CrossContractError';
  }
}

/**
 * Builds the error type expected for a given cross-contract failure scenario.
 * Missing contracts surface as `ContractError`, ineligible listings and
 * overlapping reservations as `AvailabilityError`, and downstream failures as
 * `EscrowError` so callers can branch on the failure class.
 */
export function crossContractFailure(
  context: CrossContractFailureContext,
): ContractError | AvailabilityError | EscrowError {
  const { scenario, contractMethod, cause } = context;
  const message = CROSS_CONTRACT_FAILURE_MESSAGES[scenario];

  switch (scenario) {
    case 'missing_contract':
      return new ContractError(message, contractMethod);
    case 'inactive_listing':
    case 'overlapping_reservation':
      return new AvailabilityError(message);
    case 'downstream_failure': {
      const statusCode =
        cause instanceof EscrowError ? cause.statusCode : undefined;
      return new EscrowError(message, statusCode);
    }
    default: {
      const exhaustive: never = scenario;
      throw new Error(`Unhandled cross-contract failure scenario: ${String(exhaustive)}`);
    }
  }
}
