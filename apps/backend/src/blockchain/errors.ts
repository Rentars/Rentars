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
