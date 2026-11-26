/**
 * #941: acceptance of a modification is one transaction; rejected, expired,
 * conflicting or unpayable proposals must leave the booking untouched.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';

const from = mock((_: string) => ({}));
const rpc = mock(async (_fn: string, _args: Record<string, unknown>) => ({ data: null, error: null }));
const notification = mock(async () => ({ success: true }));

mock.module('../../src/config/supabase.js', () => ({ supabase: { from, rpc } }));
mock.module('../../src/blockchain/bookingContract.js', () => ({
  checkAvailability: mock(async () => true),
  createBookingOnChain: mock(async () => 1n),
  cancelBookingOnChain: mock(async () => {}),
  updateBookingStatusOnChain: mock(async () => {}),
}));
mock.module('../../src/services/logging.service.js', () => ({
  loggingService: { logBlockchainOperation: mock(() => {}) },
}));
mock.module('../../src/services/notification.service.js', () => ({ createNotification: notification }));
mock.module('../../src/services/availability.service.js', () => ({
  checkDateRangeAvailability: mock(async () => ({ success: true, data: { is_available: true } })),
}));
mock.module('../../src/services/pricing.service.js', () => ({
  calculateRangePrice: mock(async () => ({ success: true, data: { total: 500, breakdown: [] } })),
}));
mock.module('../../src/blockchain/trustlessWork.js', () => ({
  trustlessWorkClient: { createBookingEscrow: mock(async () => ({ escrowId: 'e' })) },
}));

const { BookingService } = await import('../../src/services/booking.service.js');

const BOOKING = {
  id: 'booking-1',
  property_id: 'property-1',
  tenant_id: 'tenant-1',
  check_in: '2026-12-01',
  check_out: '2026-12-05',
  total_price: 400,
  status: 'Confirmed',
  properties: { owner_id: 'host-1', base_price_per_night: 100 },
};
const MODIFICATION = {
  id: 'mod-1',
  booking_id: BOOKING.id,
  requested_by: BOOKING.tenant_id,
  status: 'pending',
  requested_start: '2026-12-10',
  requested_end: '2026-12-14',
  original_start: BOOKING.check_in,
  original_end: BOOKING.check_out,
  original_total_price: 400,
  expires_at: new Date(Date.now() + 60_000).toISOString(),
  booking_snapshot: { total_price: 400 },
};

function setup(modification = MODIFICATION) {
  from.mockImplementation((table: string) => ({
    select: () => ({
      eq: () => ({
        eq: () => ({ single: async () => ({ data: modification, error: null }) }),
        single: async () => ({ data: BOOKING, error: null }),
      }),
    }),
  }));
}

describe('booking modification transactional acceptance', () => {
  let service: InstanceType<typeof BookingService>;
  beforeEach(() => {
    from.mockReset();
    rpc.mockReset();
    notification.mockClear();
    setup();
    service = new BookingService();
  });

  it('saves dates, price delta and adjustment state through the atomic RPC only', async () => {
    rpc.mockResolvedValue({ data: { ...BOOKING, check_in: MODIFICATION.requested_start, total_price: 500 }, error: null });
    const result = await service.acceptModification(BOOKING.id, 'host-1', MODIFICATION.id);
    expect(result.success).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][0]).toBe('accept_booking_modification_atomic');
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_booking_id: BOOKING.id,
      p_modification_id: MODIFICATION.id,
      p_check_in: MODIFICATION.requested_start,
      p_total_price: 500,
      p_price_delta: 100,
      p_requires_additional_payment: true,
    });
  });

  it('leaves the booking unchanged for an expired proposal', async () => {
    setup({ ...MODIFICATION, expires_at: new Date(Date.now() - 1000).toISOString() });
    const result = await service.acceptModification(BOOKING.id, 'host-1', MODIFICATION.id);
    expect(result.success).toBe(false);
    expect(result.code).toBe('MODIFICATION_EXPIRED');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('does not write anything for a proposal that is no longer pending', async () => {
    setup({ ...MODIFICATION, status: 'declined' });
    const result = await service.acceptModification(BOOKING.id, 'host-1', MODIFICATION.id);
    expect(result.success).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('maps a concurrent booking conflict to 409 without a partial write', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '23P01', message: 'conflict' } });
    const result = await service.acceptModification(BOOKING.id, 'host-1', MODIFICATION.id);
    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(409);
    expect(notification).not.toHaveBeenCalled();
  });

  it('reports a failed payment adjustment as a conflict and never notifies success', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'PAYMENT_ADJUSTMENT_FAILED' } });
    const result = await service.acceptModification(BOOKING.id, 'host-1', MODIFICATION.id);
    expect(result.success).toBe(false);
    expect(notification).not.toHaveBeenCalled();
  });
});
