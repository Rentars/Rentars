/**
 * Jest manual mock for bookingContract module.
 */

export const checkAvailability = jest.fn().mockResolvedValue(true);
export const createBookingOnChain = jest.fn().mockResolvedValue(BigInt(1));
export const cancelBookingOnChain = jest.fn().mockResolvedValue(undefined);
export const updateBookingStatusOnChain = jest.fn().mockResolvedValue(undefined);

export const getBooking = jest.fn().mockResolvedValue({
  id: BigInt(1),
  propertyId: BigInt(1),
  tenant: 'GTENANT',
  landlord: 'GLANDLORD',
  startDate: BigInt(0),
  endDate: BigInt(0),
  status: 'Pending',
  escrowFunded: false,
});

export const getPropertyBookings = jest.fn().mockResolvedValue([]);
export const bookingCount = jest.fn().mockResolvedValue(BigInt(0));
export const setTokenAddressOnChain = jest.fn().mockResolvedValue(undefined);
export const fundEscrowOnChain = jest.fn().mockResolvedValue(undefined);
export const disputeBookingOnChain = jest.fn().mockResolvedValue(undefined);
export const resolveDisputeOnChain = jest.fn().mockResolvedValue(undefined);