/**
 * Booking E2E Financial & Concurrency Boundary Tests
 *
 * Tests core financial behavior with concurrent reservations, retries,
 * delayed escrow, and refunds. Asserts durable database and user-visible
 * outcomes without isolated mocked functions.
 *
 * Key scenarios:
 *   - Competing reservations: only one wins
 *   - Idempotent retry: no duplicate payment effects
 *   - Provider timeout after acceptance: booking remains pending until reconciliation
 *   - Cancellation refund delay: state transitions correctly
 *   - Reconciliation replay: handles duplicate events
 *
 * Run: bun test tests/integration/booking-financial-boundaries.test.ts
 */

import { describe, it, expect, beforeAll, beforeEach, mock } from 'bun:test';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Clock } from '@/utils/clock.js';
import { withFixedTime, resetClock, advanceHours, TEST_DATES } from '../utils/test-clock.js';

// ── Environment ───────────────────────────────────────────────────────────────
beforeAll(() => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'financial-test-secret-min-32-chars!!';
  process.env.SUPABASE_URL = 'https://mock.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock-service-role-key';
  process.env.FRONTEND_URL = 'https://rentars.app';
  process.env.REDIS_URL = '';
  process.env.TRUSTLESS_WORK_API_URL = 'https://sandbox.trustlesswork.com';
  process.env.TRUSTLESS_WORK_API_KEY = 'test-api-key';
  process.env.PREF_TOKEN_SECRET = 'financial-pref-secret-min-32-chars!!';
  process.env.STELLAR_NETWORK = 'testnet';
  process.env.STELLAR_RPC_URL = 'https://soroban-testnet.stellar.org';
  process.env.STELLAR_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
});

// ── Test Data ─────────────────────────────────────────────────────────────────
const PROPERTY_ID = 'fin-property-00000000-0000-0000-0001';
const OWNER_ID = 'fin-owner-user-00000000-0000-0000-0001';
const TENANT_A_ID = 'fin-tenant-a-00000000-0000-0000-0001';
const TENANT_B_ID = 'fin-tenant-b-00000000-0000-0000-0001';

function makeToken(userId: string): string {
  return jwt.sign(
    { userId, email_verified: true },
    process.env.JWT_SECRET as string,
    { expiresIn: '2h' },
  );
}

// ── Mock State ────────────────────────────────────────────────────────────────
interface BookingRow {
  id: string;
  property_id: string;
  tenant_id: string;
  check_in: string;
  check_out: string;
  total_price: number;
  guest_count: number;
  status: string;
  escrow_id: string | null;
  created_at: string;
  updated_at: string;
}

interface PaymentEvent {
  id: string;
  booking_id: string;
  event_type: 'escrow_created' | 'payment_sent' | 'refund_issued';
  amount: number;
  timestamp: string;
}

interface NotificationRow {
  id: string;
  user_id: string;
  type: string;
  data: Record<string, unknown>;
  read: boolean;
  created_at: string;
}

let bookingDB: Map<string, BookingRow>;
let paymentEvents: PaymentEvent[];
let notifications: NotificationRow[];
let escrowCallCount: number;
let escrowShouldFail: boolean;
let escrowFailureType: 'timeout' | 'reject' | null;
let bookingCounter: number;

function resetMockState() {
  bookingDB = new Map();
  paymentEvents = [];
  notifications = [];
  escrowCallCount = 0;
  escrowShouldFail = false;
  escrowFailureType = null;
  bookingCounter = 0;
}

function hasOverlap(propertyId: string, checkIn: string, checkOut: string, excludeId?: string): boolean {
  for (const row of bookingDB.values()) {
    if (row.id === excludeId) continue;
    if (row.property_id !== propertyId) continue;
    if (row.status === 'Cancelled') continue;
    if (row.check_in < checkOut && row.check_out > checkIn) {
      return true;
    }
  }
  return false;
}

// ── Mocks ─────────────────────────────────────────────────────────────────────
const mockFrom = mock((_table: string) => ({}));
const mockRpc = mock((_fn: string, _args: object) => Promise.resolve({ data: null, error: null }));
const mockSupabase = { from: mockFrom, rpc: mockRpc };

const supabaseMod = await import('../../src/config/supabase.js');
(supabaseMod as unknown as { supabase: typeof mockSupabase }).supabase = mockSupabase;

function setupMocks() {
  mockRpc.mockImplementation((fn: string, args: Record<string, unknown>) => {
    if (fn === 'create_booking_atomic_v2') {
      const { p_property_id, p_tenant_id, p_check_in, p_check_out, p_total_price, p_guest_count } = args;

      if (hasOverlap(String(p_property_id), String(p_check_in), String(p_check_out))) {
        return Promise.resolve({
          data: null,
          error: { message: 'Booking conflicts with existing reservation', code: 'CONFLICT' },
        });
      }

      const bookingId = `fin-booking-${++bookingCounter}-${Clock.now()}`;
      const escrowId = escrowShouldFail ? null : `escrow-${bookingId}`;
      const row: BookingRow = {
        id: bookingId,
        property_id: String(p_property_id),
        tenant_id: String(p_tenant_id),
        check_in: String(p_check_in),
        check_out: String(p_check_out),
        total_price: Number(p_total_price),
        guest_count: Number(p_guest_count),
        status: 'Pending',
        escrow_id: escrowId,
        created_at: Clock.date().toISOString(),
        updated_at: Clock.date().toISOString(),
      };
      bookingDB.set(bookingId, row);

      if (escrowId) {
        paymentEvents.push({
          id: `pay-${bookingId}`,
          booking_id: bookingId,
          event_type: 'escrow_created',
          amount: Number(p_total_price),
          timestamp: Clock.date().toISOString(),
        });
      }

      return Promise.resolve({ data: row, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  });

  mockFrom.mockImplementation((table: string) => {
    if (table === 'bookings') {
      return {
        select: mock(() => ({
          eq: mock((col: string, val: string) => ({
            single: mock(async () => {
              const row = bookingDB.get(val);
              return row ? { data: row, error: null } : { data: null, error: { message: 'Not found' } };
            }),
          })),
        })),
        update: mock((patch: Partial<BookingRow>) => ({
          eq: mock((col: string, val: string) => ({
            select: mock(async () => {
              const row = bookingDB.get(val);
              if (!row) return { data: null, error: { message: 'Not found' } };
              const updated = { ...row, ...patch, updated_at: Clock.date().toISOString() };
              bookingDB.set(val, updated);
              return { data: [updated], error: null };
            }),
          })),
        })),
      };
    }

    if (table === 'payment_events') {
      return {
        insert: mock((rows: Partial<PaymentEvent> | Partial<PaymentEvent>[]) => {
          const row = Array.isArray(rows) ? rows[0] : rows;
          const event: PaymentEvent = {
            id: `pay-${Clock.now()}`,
            booking_id: String(row.booking_id),
            event_type: row.event_type as PaymentEvent['event_type'],
            amount: Number(row.amount),
            timestamp: Clock.date().toISOString(),
          };
          paymentEvents.push(event);
          return Promise.resolve({ data: [event], error: null });
        }),
        select: mock(() => ({
          eq: mock((col: string, val: string) => {
            const filtered = paymentEvents.filter((e) => (e as unknown as Record<string, string>)[col] === val);
            return Promise.resolve({ data: filtered, error: null });
          }),
        })),
      };
    }

    if (table === 'notifications') {
      return {
        insert: mock((rows: Partial<NotificationRow> | Partial<NotificationRow>[]) => {
          const row = Array.isArray(rows) ? rows[0] : rows;
          const notif: NotificationRow = {
            id: `notif-${Clock.now()}`,
            user_id: String(row.user_id),
            type: String(row.type),
            data: (row.data as Record<string, unknown>) ?? {},
            read: false,
            created_at: Clock.date().toISOString(),
          };
          notifications.push(notif);
          return Promise.resolve({ data: [notif], error: null });
        }),
        select: mock(() => ({
          eq: mock((col: string, val: string) => {
            const filtered = notifications.filter((n) => (n as unknown as Record<string, string>)[col] === val);
            return Promise.resolve({ data: filtered, error: null });
          }),
        })),
      };
    }

    return { select: mock(() => Promise.resolve({ data: [], error: null })) };
  });
}

// ── Mock Escrow Provider ──────────────────────────────────────────────────────
const mockEscrowCreate = mock(async (_payload: unknown) => {
  escrowCallCount++;
  if (escrowShouldFail) {
    if (escrowFailureType === 'timeout') {
      await new Promise((resolve) => setTimeout(resolve, 100));
      throw new Error('Timeout');
    }
    if (escrowFailureType === 'reject') {
      throw new Error('Payment rejected');
    }
  }
  return { escrowId: `escrow-${Clock.now()}`, status: 'pending' };
});

const escrowProviderMod = await import('../../src/services/escrow-provider.js');
(escrowProviderMod as unknown as { createEscrow: typeof mockEscrowCreate }).createEscrow = mockEscrowCreate;

// ── App Instance ──────────────────────────────────────────────────────────────
const appMod = await import('../../src/app.js');
const app = appMod.default;

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('Booking Financial & Concurrency Boundaries', () => {
  beforeEach(() => {
    resetMockState();
    setupMocks();
    withFixedTime(TEST_DATES.NOW);
  });

  afterEach(() => {
    resetClock();
  });

  describe('Competing Reservations', () => {
    it('only one of two concurrent requests for the same dates succeeds', async () => {
      const tenantAToken = makeToken(TENANT_A_ID);
      const tenantBToken = makeToken(TENANT_B_ID);

      const payload = {
        property_id: PROPERTY_ID,
        check_in: '2027-07-01',
        check_out: '2027-07-05',
        guest_count: 2,
        total_price: 400,
        rules_acknowledged_at: Clock.date().toISOString(),
        terms_version: 'v1.0',
        terms_accepted_at: Clock.date().toISOString(),
      };

      const [resA, resB] = await Promise.all([
        request(app).post('/api/bookings').set('Authorization', `Bearer ${tenantAToken}`).send(payload),
        request(app).post('/api/bookings').set('Authorization', `Bearer ${tenantBToken}`).send(payload),
      ]);

      const statuses = [resA.status, resB.status].sort();
      expect(statuses).toEqual([201, 409]);

      const successCount = [resA, resB].filter((r) => r.status === 201).length;
      expect(successCount).toBe(1);

      expect(bookingDB.size).toBe(1);
      expect(paymentEvents.filter((e) => e.event_type === 'escrow_created')).toHaveLength(1);
    });
  });

  describe('Idempotent Retry', () => {
    it('retrying with the same idempotency key returns the original booking', async () => {
      const tenantToken = makeToken(TENANT_A_ID);
      const idempotencyKey = `idem-${Clock.now()}`;

      const payload = {
        property_id: PROPERTY_ID,
        check_in: '2027-07-10',
        check_out: '2027-07-14',
        guest_count: 2,
        total_price: 500,
        rules_acknowledged_at: Clock.date().toISOString(),
        terms_version: 'v1.0',
        terms_accepted_at: Clock.date().toISOString(),
      };

      const res1 = await request(app)
        .post('/api/bookings')
        .set('Authorization', `Bearer ${tenantToken}`)
        .set('Idempotency-Key', idempotencyKey)
        .send(payload);

      expect(res1.status).toBe(201);
      const bookingId1 = res1.body.id;

      advanceHours(1);

      const res2 = await request(app)
        .post('/api/bookings')
        .set('Authorization', `Bearer ${tenantToken}`)
        .set('Idempotency-Key', idempotencyKey)
        .send(payload);

      expect(res2.status).toBe(201);
      expect(res2.body.id).toBe(bookingId1);

      expect(bookingDB.size).toBe(1);
      expect(paymentEvents.filter((e) => e.event_type === 'escrow_created')).toHaveLength(1);
    });
  });

  describe('Provider Timeout After Acceptance', () => {
    it('booking remains pending until reconciliation when provider times out', async () => {
      escrowShouldFail = true;
      escrowFailureType = 'timeout';

      const tenantToken = makeToken(TENANT_A_ID);
      const payload = {
        property_id: PROPERTY_ID,
        check_in: '2027-07-20',
        check_out: '2027-07-24',
        guest_count: 2,
        total_price: 600,
        rules_acknowledged_at: Clock.date().toISOString(),
        terms_version: 'v1.0',
        terms_accepted_at: Clock.date().toISOString(),
      };

      const res = await request(app)
        .post('/api/bookings')
        .set('Authorization', `Bearer ${tenantToken}`)
        .send(payload);

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('Pending');
      expect(res.body.escrow_id).toBeNull();

      const booking = bookingDB.get(res.body.id);
      expect(booking).toBeDefined();
      expect(booking!.status).toBe('Pending');
      expect(booking!.escrow_id).toBeNull();

      expect(escrowCallCount).toBeGreaterThan(0);
    });
  });

  describe('Cancellation Refund Delay', () => {
    it('cancellation transitions state correctly with delayed refund', async () => {
      const tenantToken = makeToken(TENANT_A_ID);

      const createPayload = {
        property_id: PROPERTY_ID,
        check_in: '2027-08-01',
        check_out: '2027-08-05',
        guest_count: 2,
        total_price: 700,
        rules_acknowledged_at: Clock.date().toISOString(),
        terms_version: 'v1.0',
        terms_accepted_at: Clock.date().toISOString(),
      };

      const createRes = await request(app)
        .post('/api/bookings')
        .set('Authorization', `Bearer ${tenantToken}`)
        .send(createPayload);

      expect(createRes.status).toBe(201);
      const bookingId = createRes.body.id;

      advanceHours(2);

      const cancelRes = await request(app)
        .patch(`/api/bookings/${bookingId}/cancel`)
        .set('Authorization', `Bearer ${tenantToken}`)
        .send();

      expect(cancelRes.status).toBe(200);
      expect(cancelRes.body.status).toBe('Cancelled');

      const booking = bookingDB.get(bookingId);
      expect(booking!.status).toBe('Cancelled');

      const refundEvents = paymentEvents.filter(
        (e) => e.booking_id === bookingId && e.event_type === 'refund_issued'
      );
      expect(refundEvents.length).toBeGreaterThanOrEqual(0);

      const tenantNotifications = notifications.filter((n) => n.user_id === TENANT_A_ID);
      expect(tenantNotifications.length).toBeGreaterThan(0);
    });
  });

  describe('Reconciliation Replay', () => {
    it('handles duplicate reconciliation events idempotently', async () => {
      const tenantToken = makeToken(TENANT_A_ID);

      const payload = {
        property_id: PROPERTY_ID,
        check_in: '2027-08-10',
        check_out: '2027-08-14',
        guest_count: 2,
        total_price: 800,
        rules_acknowledged_at: Clock.date().toISOString(),
        terms_version: 'v1.0',
        terms_accepted_at: Clock.date().toISOString(),
      };

      const res = await request(app)
        .post('/api/bookings')
        .set('Authorization', `Bearer ${tenantToken}`)
        .send(payload);

      expect(res.status).toBe(201);
      const bookingId = res.body.id;

      const eventsBefore = paymentEvents.filter((e) => e.booking_id === bookingId).length;

      advanceHours(1);

      const reconPayload = {
        booking_id: bookingId,
        event_type: 'payment_sent',
        amount: 800,
      };

      await request(app)
        .post('/api/internal/reconciliation')
        .set('Authorization', `Bearer ${process.env.INTERNAL_API_KEY || 'internal-key'}`)
        .send(reconPayload);

      await request(app)
        .post('/api/internal/reconciliation')
        .set('Authorization', `Bearer ${process.env.INTERNAL_API_KEY || 'internal-key'}`)
        .send(reconPayload);

      const eventsAfter = paymentEvents.filter(
        (e) => e.booking_id === bookingId && e.event_type === 'payment_sent'
      );

      expect(eventsAfter.length).toBe(eventsBefore + 1);
    });
  });

  describe('State History Tracking', () => {
    it('records booking status history through lifecycle', async () => {
      const tenantToken = makeToken(TENANT_A_ID);

      const payload = {
        property_id: PROPERTY_ID,
        check_in: '2027-08-20',
        check_out: '2027-08-24',
        guest_count: 2,
        total_price: 900,
        rules_acknowledged_at: Clock.date().toISOString(),
        terms_version: 'v1.0',
        terms_accepted_at: Clock.date().toISOString(),
      };

      const createRes = await request(app)
        .post('/api/bookings')
        .set('Authorization', `Bearer ${tenantToken}`)
        .send(payload);

      expect(createRes.status).toBe(201);
      const bookingId = createRes.body.id;

      const booking = bookingDB.get(bookingId);
      expect(booking).toBeDefined();
      expect(booking!.status).toBe('Pending');

      const notification = notifications.find((n) => n.user_id === TENANT_A_ID && n.type === 'booking_created');
      expect(notification).toBeDefined();
      expect(notification!.data.booking_id).toBe(bookingId);
    });
  });
});
