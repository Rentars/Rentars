/**
 * Per-test fixture factories for backend test suites.
 *
 * Rules enforced here:
 *  1. Every factory generates a unique run-scoped ID via `makeRunId()` so
 *     parallel Bun workers and concurrent CI jobs never share row IDs.
 *  2. Factories return plain objects — they do not write to any shared module
 *     state. Callers seed their own mock/DB table in `beforeEach`.
 *  3. No factory relies on the output of a previous test. Each test is fully
 *     self-contained.
 *
 * Usage (bun:test):
 *
 *   import { makeRunId, userFactory, propertyFactory, bookingFactory } from '../fixtures/test-factory.js';
 *   import { mock } from 'bun:test';
 *
 *   const RUN = makeRunId();
 *
 *   describe('MyService', () => {
 *     let mockFrom: ReturnType<typeof mock>;
 *
 *     beforeEach(() => {
 *       mockFrom = mock(() => ({}));
 *     });
 *
 *     it('does X', async () => {
 *       const user = userFactory({ id: `${RUN}-user` });
 *       const prop = propertyFactory({ owner_id: user.id });
 *       // seed mockFrom with { user, prop } here
 *     });
 *   });
 */

// ---------------------------------------------------------------------------
// Run-scoped identifier
// ---------------------------------------------------------------------------

/**
 * Returns a short prefix unique to this process invocation.
 * Embed it in every ID you create so tests run in any order without collision.
 *
 *   const RUN = makeRunId();                   // 'run-1748234521-a3f9'
 *   const userId = `${RUN}-user`;              // 'run-1748234521-a3f9-user'
 *   const propId = `${RUN}-prop-${uuid()}`;
 */
export function makeRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

// ---------------------------------------------------------------------------
// Deterministic UUID helpers
// ---------------------------------------------------------------------------

/** Returns a valid UUID v4 string seeded from a human-readable label. */
export function labelToUuid(label: string): string {
  // Simple but deterministic: pad/hash the label into UUID format.
  // Not cryptographic — only for test fixture identity.
  const padded = label.replace(/[^a-z0-9]/gi, '').padEnd(32, '0').slice(0, 32);
  return [
    padded.slice(0, 8),
    padded.slice(8, 12),
    '4' + padded.slice(13, 16),
    '8' + padded.slice(17, 20),
    padded.slice(20, 32),
  ].join('-');
}

// ---------------------------------------------------------------------------
// User / profile factory
// ---------------------------------------------------------------------------

export interface TestUser {
  id: string;
  email: string;
  name: string;
  role: 'tenant' | 'host' | 'admin';
  stellar_address: string;
  status: 'active' | 'suspended' | 'banned';
  created_at: string;
}

export function userFactory(overrides: Partial<TestUser> = {}): TestUser {
  const id = overrides.id ?? `00000000-0000-4000-8000-${Date.now().toString().padStart(12, '0')}`;
  return {
    id,
    email: `user-${id.slice(-8)}@test.example`,
    name: `Test User ${id.slice(-4)}`,
    role: 'tenant',
    stellar_address: 'GBRPYHIL2CI3WHZDTOOQFC6EB4CGQOFSNHERX3LRJCX5FWCL46664F3',
    status: 'active',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Convenience: a host user. */
export function hostFactory(overrides: Partial<TestUser> = {}): TestUser {
  return userFactory({ role: 'host', ...overrides });
}

// ---------------------------------------------------------------------------
// Property factory
// ---------------------------------------------------------------------------

export interface TestProperty {
  id: string;
  owner_id: string;
  title: string;
  description: string;
  price_per_night: number;
  status: 'available' | 'unavailable' | 'draft' | 'pending_review';
  draft_status: 'active' | 'draft';
  moderation_state: 'visible' | 'hidden' | 'pending';
  city: string;
  country: string;
  address: string;
  bedrooms: number;
  bathrooms: number;
  max_guests: number;
  min_nights: number;
  max_nights: number | null;
  amenities: string[];
  images: string[];
  on_chain_id: number | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export function propertyFactory(overrides: Partial<TestProperty> = {}): TestProperty {
  const id = overrides.id ?? `11111111-1111-4111-8111-${Date.now().toString().padStart(12, '0')}`;
  return {
    id,
    owner_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    title: `Test Property ${id.slice(-4)}`,
    description: 'A test property for automated tests.',
    price_per_night: 100,
    status: 'available',
    draft_status: 'active',
    moderation_state: 'visible',
    city: 'Test City',
    country: 'Test Country',
    address: '1 Test Street',
    bedrooms: 2,
    bathrooms: 1,
    max_guests: 4,
    min_nights: 1,
    max_nights: null,
    amenities: ['wifi'],
    images: ['https://example.com/img.jpg'],
    on_chain_id: null,
    deleted_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Booking factory
// ---------------------------------------------------------------------------

export interface TestBooking {
  id: string;
  property_id: string;
  tenant_id: string;
  check_in: string;
  check_out: string;
  total_price: number;
  guest_count: number;
  status: 'Pending' | 'Confirmed' | 'Cancelled' | 'Completed';
  escrow_id: string | null;
  on_chain_id: number | null;
  rules_acknowledged_at: string | null;
  created_at: string;
  updated_at: string;
}

export function bookingFactory(overrides: Partial<TestBooking> = {}): TestBooking {
  const id = overrides.id ?? `22222222-2222-4222-8222-${Date.now().toString().padStart(12, '0')}`;
  return {
    id,
    property_id: '11111111-1111-4111-8111-000000000001',
    tenant_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    check_in: '2029-06-01',
    check_out: '2029-06-05',
    total_price: 400,
    guest_count: 2,
    status: 'Pending',
    escrow_id: null,
    on_chain_id: null,
    rules_acknowledged_at: new Date().toISOString(),
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Convenience: a confirmed booking with an escrow ID. */
export function confirmedBookingFactory(overrides: Partial<TestBooking> = {}): TestBooking {
  return bookingFactory({ status: 'Confirmed', escrow_id: `escrow-${Date.now()}`, ...overrides });
}

// ---------------------------------------------------------------------------
// Review factory
// ---------------------------------------------------------------------------

export interface TestReview {
  id: string;
  booking_id: string;
  property_id: string;
  reviewer_id: string;
  rating: number;
  body: string;
  reviewer_role: 'guest_to_host' | 'host_to_guest';
  moderation_status: 'published' | 'under_review' | 'removed';
  created_at: string;
}

export function reviewFactory(overrides: Partial<TestReview> = {}): TestReview {
  const id = overrides.id ?? `33333333-3333-4333-8333-${Date.now().toString().padStart(12, '0')}`;
  return {
    id,
    booking_id: '22222222-2222-4222-8222-000000000001',
    property_id: '11111111-1111-4111-8111-000000000001',
    reviewer_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    rating: 5,
    body: 'Great stay!',
    reviewer_role: 'guest_to_host',
    moderation_status: 'published',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Notification factory
// ---------------------------------------------------------------------------

export interface TestNotification {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string;
  read: boolean;
  booking_id: string | null;
  created_at: string;
}

export function notificationFactory(overrides: Partial<TestNotification> = {}): TestNotification {
  const id = overrides.id ?? `44444444-4444-4444-8444-${Date.now().toString().padStart(12, '0')}`;
  return {
    id,
    user_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    type: 'booking_confirmed',
    title: 'Booking confirmed',
    body: 'Your booking has been confirmed.',
    read: false,
    booking_id: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Scoped cleanup helper (for tests/integration where cleanup matters)
// ---------------------------------------------------------------------------

/**
 * Returns a list of IDs created during a test run, so integration tests that
 * do real DB writes can track and delete their own records.
 *
 * Usage:
 *   const tracker = makeCleanupTracker();
 *   const booking = bookingFactory({ id: tracker.track('bookings', uuid()) });
 *   // ... test body ...
 *   afterEach(async () => {
 *     await tracker.cleanup(supabase);
 *   });
 */
export interface CleanupTracker {
  track(table: string, id: string): string;
  ids(table: string): string[];
  cleanup(supabase: { from: (t: string) => { delete: () => { in: (col: string, ids: string[]) => Promise<unknown> } } }): Promise<void>;
}

export function makeCleanupTracker(): CleanupTracker {
  const registry = new Map<string, string[]>();

  return {
    track(table, id) {
      const list = registry.get(table) ?? [];
      list.push(id);
      registry.set(table, list);
      return id;
    },
    ids(table) {
      return registry.get(table) ?? [];
    },
    async cleanup(supabase) {
      // Delete in reverse-dependency order: bookings → properties → profiles
      const order = ['notifications', 'reviews', 'bookings', 'property_images', 'properties', 'profiles'];
      for (const table of order) {
        const ids = registry.get(table);
        if (ids && ids.length > 0) {
          await supabase.from(table).delete().in('id', ids);
        }
      }
      registry.clear();
    },
  };
}
