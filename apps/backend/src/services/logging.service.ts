export interface BlockchainOperationLog {
  operation: string;
  userId?: string;
  bookingId?: string;
  propertyId?: string;
  txHash?: string;
  escrowId?: string;
  error?: string;
  [key: string]: unknown;
}

export const loggingService = {
  logBlockchainOperation(details: BlockchainOperationLog): void {
    const { operation, ...rest } = details;
    console.log(`[Blockchain:${operation}]`, JSON.stringify(rest));
  },
};
