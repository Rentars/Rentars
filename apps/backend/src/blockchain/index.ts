/**
 * Blockchain client module for Rentars.
 *
 * Exports typed clients for each Soroban contract, shared utilities,
 * and the TrustlessWork escrow client.
 */

export { BookingClient } from './bookingClient.js';
export { PropertyListingClient } from './propertyListingClient.js';
export { ReviewClient } from './reviewClient.js';

export {
  createBookingOnChain,
  cancelBookingOnChain,
  updateBookingStatusOnChain,
  checkAvailability,
} from './bookingContract.js';

export {
  createPropertyListing,
  updatePropertyListing,
  getPropertyListing,
  updatePropertyStatus,
  verifyPropertyIntegrity,
  propertyToHashData,
} from './propertyListingContract.js';

export { getSorobanServer, submitAndWait, buildFeeBump } from './soroban.js';

export {
  buildTransaction,
  signTransaction,
  buildPrepareAndSign,
  extractReturnValue,
} from './transactionUtils.js';

export {
  TrustlessWorkClient,
  trustlessWorkClient,
} from './trustlessWork.js';

export {
  BlockchainError,
  ContractError,
  TransactionError,
  AvailabilityError,
  EscrowError,
} from './errors.js';

export type {
  Booking,
  BookingStatus,
  CreateBookingParams,
  CreateListingParams,
  ListingStatus,
  PropertyListing,
  Review,
  SubmitReviewParams,
  UpdateListingParams,
} from './types.js';

export type {
  CreateEscrowRequest,
  CreateEscrowResponse,
  EscrowStatus,
  FundEscrowRequest,
  ReleaseEscrowRequest,
  BookingEscrowParams,
} from './trustlessWork.js';

export type { OnChainPropertyData } from './propertyListingContract.js';
