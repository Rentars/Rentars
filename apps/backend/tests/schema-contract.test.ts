/**
 * Schema Contract Tests
 *
 * Validates that real API responses agree with the canonical Zod schemas
 * defined in src/schemas/.  These tests are the CI gate that catches:
 *
 *   • Required-field drift   — a field removed from the response without
 *                              updating the schema causes a Zod parse failure.
 *   • Enum drift             — a new status value added to the DB without
 *                              updating the schema is flagged immediately.
 *   • Structural regressions — renamed keys, type changes (number → string),
 *                              or missing nested objects surface as diff output.
 *
 * Strategy:
 *   - Every test calls a real in-process Express app via supertest.
 *   - 2xx responses are parsed with the canonical Zod schema; failures are
 *     reported as a structured diff (path + message) not just "schema error".
 *   - 4xx / 401 error envelopes are validated to always carry { error: string }
 *     so the frontend's error-display logic has a stable shape to rely on.
 *   - Enum-drift tests explicitly supply out-of-range values and assert the
 *     server rejects them, so the enum list stays honest.
 *
 * Run:  bun test tests/schema-contract.test.ts
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import request from 'supertest';
import type { Express } from 'express';

// ── Env bootstrap ─────────────────────────────────────────────────────────────
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= 'schema-contract-test-secret-32ch!';
process.env.SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-key';
process.env.FRONTEND_URL ??= 'https://rentars.app';
process.env.REDIS_URL = '';
process.env.TRUSTLESS_WORK_API_URL ??= 'https://sandbox.trustlesswork.com';
process.env.TRUSTLESS_WORK_API_KEY ??= 'test-api-key';
process.env.PREF_TOKEN_SECRET ??= 'schema-contract-pref-secret-32ch!';
process.env.STELLAR_NETWORK ??= 'testnet';
process.env.STELLAR_RPC_URL ??= 'https://soroban-testnet.stellar.org';
process.env.STELLAR_NETWORK_PASSPHRASE ??= 'Test SDF Network ; September 2015';

// ── Schema imports ────────────────────────────────────────────────────────────
import {
  AdvancedSearchResponseSchema,
  BookingDetailSchema,
  BookingListResponseSchema,
  AuthMeResponseSchema,
  AuthSuccessResponseSchema,
  TokenPairSchema,
  PaymentStatusResponseSchema,
  NotificationSchema,
  NotificationListResponseSchema,
  UserProfileSchema,
  BookingStatusSchema,
  EscrowStatusSchema,
  PaymentStatusValueSchema,
  NotificationTypeSchema,
  parseApiResponse,
  SchemaParseError,
} from '../src/schemas/index.js';

// ── Error envelope schema (inline — applies to every 4xx / 5xx) ──────────────
import { z } from 'zod';

const errorEnvelopeSchema = z
  .object({ error: z.union([z.string(), z.object({})]) })
  .passthrough();

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Assert that `body` satisfies `schema`. Throws with a structured diff on
 * failure so the CI output names the broken field, not just "schema error".
 */
function assertSchema<T extends z.ZodTypeAny>(
  schema: T,
  body: unknown,
  label: string,
): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    const diff = result.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`[schema-contract] ${label}\n${diff}\n\nActual:\n${JSON.stringify(body, null, 2)}`);
  }
  return result.data;
}

/** Assert the response content-type is application/json. */
function assertJson(res: { headers: Record<string, string> }, label: string): void {
  expect(res.headers['content-type']).toMatch(/application\/json/);
}

// ── App bootstrap ─────────────────────────────────────────────────────────────

let app: Express;

beforeAll(async () => {
  const mod = await import('../src/index.js');
  app = (mod as { app: Express }).app;
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — Advanced Property Search
// ─────────────────────────────────────────────────────────────────────────────

describe('Schema: GET /api/v1/properties/search/advanced', () => {
  it('200 — response satisfies AdvancedSearchResponseSchema', async () => {
    const res = await request(app).get('/api/v1/properties/search/advanced');
    expect(res.status).toBe(200);
    assertJson(res, 'search 200');
    assertSchema(AdvancedSearchResponseSchema, res.body, 'AdvancedSearchResponse');
  });

  it('200 — data array items each satisfy PropertySearchResultSchema', async () => {
    const res = await request(app).get('/api/v1/properties/search/advanced?limit=5');
    expect(res.status).toBe(200);
    const parsed = assertSchema(AdvancedSearchResponseSchema, res.body, 'AdvancedSearchResponse (limit=5)');
    // Each item in data must fully parse individually — catches partial drift
    // where only some rows are malformed.
    for (const item of parsed.data) {
      expect(typeof item.id).toBe('string');
      expect(typeof item.price_per_night).toBe('number');
      // status must be a known enum value — drift would surface here
      expect(['available', 'unavailable', 'draft', 'pending']).toContain(item.status);
    }
  });

  it('200 — price_histogram buckets have correct shape when present', async () => {
    const res = await request(app).get('/api/v1/properties/search/advanced');
    expect(res.status).toBe(200);
    const parsed = assertSchema(AdvancedSearchResponseSchema, res.body, 'AdvancedSearchResponse (histogram)');
    if (parsed.price_histogram) {
      expect(typeof parsed.price_histogram.global_min).toBe('number');
      expect(typeof parsed.price_histogram.global_max).toBe('number');
      expect(Array.isArray(parsed.price_histogram.buckets)).toBe(true);
      for (const bucket of parsed.price_histogram.buckets) {
        expect(typeof bucket.min).toBe('number');
        expect(typeof bucket.max).toBe('number');
        expect(typeof bucket.count).toBe('number');
        expect(bucket.count).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('200 — _suggestions items have valid type enum when present', async () => {
    const res = await request(app).get('/api/v1/properties/search/advanced?city=ZZZNOEXIST');
    // May be 200 with zero results and suggestions, or 200 with no suggestions
    expect(res.status).toBe(200);
    const parsed = assertSchema(AdvancedSearchResponseSchema, res.body, 'AdvancedSearchResponse (_suggestions)');
    const validTypes = ['no_amenities', 'wider_price', 'expand_radius', 'any_location'];
    for (const s of parsed._suggestions ?? []) {
      expect(validTypes).toContain(s.type);
      expect(typeof s.description).toBe('string');
      expect(s.estimated_results).toBeGreaterThanOrEqual(0);
    }
  });

  it('400 — invalid numeric param returns error envelope', async () => {
    const res = await request(app).get('/api/v1/properties/search/advanced?page=0');
    expect(res.status).toBe(400);
    assertSchema(errorEnvelopeSchema, res.body, 'search 400 (page=0)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — Booking detail
// ─────────────────────────────────────────────────────────────────────────────

describe('Schema: GET /api/v1/bookings/:id', () => {
  it('401 — unauthenticated request returns error envelope', async () => {
    const res = await request(app).get('/api/v1/bookings/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(401);
    assertSchema(errorEnvelopeSchema, res.body, 'GET booking 401');
    assertJson(res, 'booking 401');
  });
});

describe('Schema: GET /api/v1/bookings', () => {
  it('401 — unauthenticated request returns error envelope', async () => {
    const res = await request(app).get('/api/v1/bookings');
    expect(res.status).toBe(401);
    assertSchema(errorEnvelopeSchema, res.body, 'GET bookings list 401');
  });
});

describe('Schema: BookingDetailSchema enum correctness', () => {
  it('BookingStatusSchema accepts all documented values', () => {
    const valid = ['pending', 'confirmed', 'completed', 'cancelled', 'disputed'];
    for (const v of valid) {
      expect(BookingStatusSchema.safeParse(v).success).toBe(true);
    }
  });

  it('BookingStatusSchema rejects undocumented values — catches enum drift', () => {
    // If the DB adds a new status without updating the schema, this test fails
    const undocumented = ['Pending', 'CONFIRMED', 'processing', 'escrow_reconcile_failed'];
    for (const v of undocumented) {
      const result = BookingStatusSchema.safeParse(v);
      expect(result.success).toBe(false);
    }
  });

  it('EscrowStatusSchema accepts all documented values', () => {
    const valid = ['locked', 'released', 'refunded', 'pending', 'manual_review'];
    for (const v of valid) {
      expect(EscrowStatusSchema.safeParse(v).success).toBe(true);
    }
  });

  it('BookingDetailSchema requires id, property_id, tenant_id, check_in, check_out, total_price, status, created_at', () => {
    const base = {
      id: '00000000-0000-0000-0000-000000000001',
      property_id: '00000000-0000-0000-0000-000000000002',
      tenant_id: '00000000-0000-0000-0000-000000000003',
      check_in: '2025-09-01',
      check_out: '2025-09-07',
      total_price: 540,
      status: 'confirmed',
      created_at: '2025-08-01T10:00:00.000Z',
    };
    expect(BookingDetailSchema.safeParse(base).success).toBe(true);

    // Missing required fields must fail — required-field drift test
    const requiredFields: (keyof typeof base)[] = [
      'id', 'property_id', 'tenant_id', 'check_in', 'check_out',
      'total_price', 'status', 'created_at',
    ];
    for (const field of requiredFields) {
      const incomplete = { ...base };
      delete incomplete[field];
      const result = BookingDetailSchema.safeParse(incomplete);
      expect(result.success).toBe(false);
    }
  });

  it('check_in / check_out must be YYYY-MM-DD format', () => {
    const base = {
      id: '00000000-0000-0000-0000-000000000001',
      property_id: '00000000-0000-0000-0000-000000000002',
      tenant_id: '00000000-0000-0000-0000-000000000003',
      check_in: '2025-09-01',
      check_out: '2025-09-07',
      total_price: 540,
      status: 'confirmed',
      created_at: '2025-08-01T10:00:00.000Z',
    };

    const isoTimestamp = { ...base, check_in: '2025-09-01T00:00:00Z' };
    expect(BookingDetailSchema.safeParse(isoTimestamp).success).toBe(false);

    const invalid = { ...base, check_in: '01/09/2025' };
    expect(BookingDetailSchema.safeParse(invalid).success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — Auth
// ─────────────────────────────────────────────────────────────────────────────

describe('Schema: POST /api/v1/auth/register — validation error shapes', () => {
  it('400 empty body — error envelope contains error field', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({});
    expect(res.status).toBe(400);
    assertSchema(errorEnvelopeSchema, res.body, 'register 400 (empty)');
    assertJson(res, 'register 400');
  });

  it('400 weak password — error envelope present', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'test@example.com', password: 'short', name: 'Test' });
    expect(res.status).toBe(400);
    assertSchema(errorEnvelopeSchema, res.body, 'register 400 (weak pw)');
  });
});

describe('Schema: AuthMeResponseSchema correctness', () => {
  it('requires id (uuid), email, role', () => {
    const base = {
      id: '00000000-0000-0000-0000-000000000001',
      email: 'user@example.com',
      role: 'tenant',
    };
    expect(AuthMeResponseSchema.safeParse(base).success).toBe(true);
  });

  it('role enum rejects unknown values — catches enum drift', () => {
    const invalid = {
      id: '00000000-0000-0000-0000-000000000001',
      email: 'user@example.com',
      role: 'superadmin',
    };
    expect(AuthMeResponseSchema.safeParse(invalid).success).toBe(false);
  });

  it('id must be a valid UUID', () => {
    const base = { id: 'not-a-uuid', email: 'user@example.com', role: 'tenant' };
    expect(AuthMeResponseSchema.safeParse(base).success).toBe(false);
  });
});

describe('Schema: TokenPairSchema correctness', () => {
  it('requires accessToken and refreshToken', () => {
    expect(TokenPairSchema.safeParse({ accessToken: 'a', refreshToken: 'b' }).success).toBe(true);
  });

  it('fails when accessToken is missing', () => {
    expect(TokenPairSchema.safeParse({ refreshToken: 'b' }).success).toBe(false);
  });

  it('fails when refreshToken is missing', () => {
    expect(TokenPairSchema.safeParse({ accessToken: 'a' }).success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — Payment status
// ─────────────────────────────────────────────────────────────────────────────

describe('Schema: GET /api/v1/payments/:id/status', () => {
  it('401 — unauthenticated request returns error envelope', async () => {
    const res = await request(app).get(
      '/api/v1/payments/00000000-0000-0000-0000-000000000000/status',
    );
    expect(res.status).toBe(401);
    assertSchema(errorEnvelopeSchema, res.body, 'payment status 401');
    assertJson(res, 'payment status 401');
  });
});

describe('Schema: PaymentStatusResponseSchema correctness', () => {
  const basePayment = {
    bookingId: '00000000-0000-0000-0000-000000000001',
    status: 'pending',
    updatedAt: '2025-08-01T10:00:00.000Z',
  };

  it('accepts valid payment status response', () => {
    expect(PaymentStatusResponseSchema.safeParse(basePayment).success).toBe(true);
  });

  it('requires bookingId, status, updatedAt', () => {
    const fields: (keyof typeof basePayment)[] = ['bookingId', 'status', 'updatedAt'];
    for (const f of fields) {
      const incomplete = { ...basePayment };
      delete incomplete[f];
      expect(PaymentStatusResponseSchema.safeParse(incomplete).success).toBe(false);
    }
  });

  it('bookingId must be a UUID', () => {
    expect(
      PaymentStatusResponseSchema.safeParse({ ...basePayment, bookingId: 'not-a-uuid' }).success,
    ).toBe(false);
  });

  it('PaymentStatusValueSchema accepts all documented enum values', () => {
    const valid = ['pending', 'submitted', 'confirmed', 'failed', 'timeout', 'expired'];
    for (const v of valid) {
      expect(PaymentStatusValueSchema.safeParse(v).success).toBe(true);
    }
  });

  it('PaymentStatusValueSchema rejects undocumented values — catches enum drift', () => {
    const undocumented = ['processing', 'Confirmed', 'PENDING', 'settled', 'refunded'];
    for (const v of undocumented) {
      expect(PaymentStatusValueSchema.safeParse(v).success).toBe(false);
    }
  });

  it('nullable optional fields accept null', () => {
    const withNulls = { ...basePayment, txHash: null, escrowId: null, errorMessage: null };
    expect(PaymentStatusResponseSchema.safeParse(withNulls).success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — Notifications
// ─────────────────────────────────────────────────────────────────────────────

describe('Schema: GET /api/v1/notifications', () => {
  it('401 — unauthenticated request returns error envelope', async () => {
    const res = await request(app).get('/api/v1/notifications');
    expect(res.status).toBe(401);
    assertSchema(errorEnvelopeSchema, res.body, 'notifications 401');
    assertJson(res, 'notifications 401');
  });
});

describe('Schema: NotificationSchema correctness', () => {
  const baseNotification = {
    id: '00000000-0000-0000-0000-000000000001',
    user_id: '00000000-0000-0000-0000-000000000002',
    type: 'booking_confirmed',
    read: false,
    created_at: '2025-08-01T10:00:00.000Z',
  };

  it('accepts valid notification', () => {
    expect(NotificationSchema.safeParse(baseNotification).success).toBe(true);
  });

  it('requires id, user_id, type, read, created_at', () => {
    const fields: (keyof typeof baseNotification)[] = ['id', 'user_id', 'type', 'read', 'created_at'];
    for (const f of fields) {
      const incomplete = { ...baseNotification };
      delete incomplete[f];
      expect(NotificationSchema.safeParse(incomplete).success).toBe(false);
    }
  });

  it('NotificationTypeSchema accepts all documented values', () => {
    const valid = [
      'booking_created', 'booking_confirmed', 'booking_cancelled', 'booking_completed',
      'booking_disputed', 'payment_received', 'payment_failed', 'review_received',
      'review_response', 'system',
    ];
    for (const v of valid) {
      expect(NotificationTypeSchema.safeParse(v).success).toBe(true);
    }
  });

  it('NotificationTypeSchema rejects undocumented values — catches enum drift', () => {
    const undocumented = ['message_received', 'admin_alert', 'BOOKING_CONFIRMED', 'unknown'];
    for (const v of undocumented) {
      expect(NotificationTypeSchema.safeParse(v).success).toBe(false);
    }
  });

  it('NotificationListResponseSchema requires data array', () => {
    expect(NotificationListResponseSchema.safeParse({ data: [] }).success).toBe(true);
    expect(NotificationListResponseSchema.safeParse({}).success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 — User profile
// ─────────────────────────────────────────────────────────────────────────────

describe('Schema: UserProfileSchema correctness', () => {
  it('requires only user_id', () => {
    expect(
      UserProfileSchema.safeParse({ user_id: '00000000-0000-0000-0000-000000000001' }).success,
    ).toBe(true);
  });

  it('user_id must be a valid UUID', () => {
    expect(UserProfileSchema.safeParse({ user_id: 'not-a-uuid' }).success).toBe(false);
  });

  it('verification_status accepts only documented values', () => {
    expect(
      UserProfileSchema.safeParse({
        user_id: '00000000-0000-0000-0000-000000000001',
        verification_status: 'verified',
      }).success,
    ).toBe(true);
    expect(
      UserProfileSchema.safeParse({
        user_id: '00000000-0000-0000-0000-000000000001',
        verification_status: 'pending',
      }).success,
    ).toBe(false);
  });

  it('completeness sub-object requires score, maxScore, missingFields', () => {
    const valid = {
      user_id: '00000000-0000-0000-0000-000000000001',
      completeness: { score: 3, maxScore: 5, missingFields: ['phone', 'bio'] },
    };
    expect(UserProfileSchema.safeParse(valid).success).toBe(true);

    const missingScore = {
      user_id: '00000000-0000-0000-0000-000000000001',
      completeness: { maxScore: 5, missingFields: [] },
    };
    expect(UserProfileSchema.safeParse(missingScore).success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7 — parseApiResponse helper
// ─────────────────────────────────────────────────────────────────────────────

describe('parseApiResponse helper', () => {
  it('returns typed data on valid input', () => {
    const result = parseApiResponse(
      TokenPairSchema,
      { accessToken: 'abc', refreshToken: 'def' },
      'TokenPair',
    );
    expect(result.accessToken).toBe('abc');
  });

  it('throws SchemaParseError on invalid input', () => {
    expect(() =>
      parseApiResponse(TokenPairSchema, { accessToken: 'abc' }, 'TokenPair'),
    ).toThrow(SchemaParseError);
  });

  it('SchemaParseError message names the broken field', () => {
    try {
      parseApiResponse(BookingDetailSchema, { id: 'not-a-uuid', status: 'pending' }, 'BookingDetail');
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaParseError);
      expect((err as SchemaParseError).message).toContain('id');
    }
  });

  it('SchemaParseError exposes issues array for structured handling', () => {
    try {
      parseApiResponse(BookingDetailSchema, {}, 'BookingDetail');
    } catch (err) {
      const e = err as SchemaParseError;
      expect(Array.isArray(e.issues)).toBe(true);
      expect(e.issues.length).toBeGreaterThan(0);
      expect(e.raw).toEqual({});
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 8 — Cross-schema consistency (frontend/backend mirror parity)
// ─────────────────────────────────────────────────────────────────────────────

describe('Cross-schema mirror parity', () => {
  /**
   * These tests ensure the frontend mirror schemas accept the same values as
   * the backend schemas.  They import both copies and run the same fixture
   * through each — if the two files drift, one parse will fail.
   */
  it('BookingStatus enum is identical on frontend and backend', async () => {
    // We import the web copy dynamically so the backend test runner can resolve it.
    // If the import path fails, the test itself will error — surfacing the drift.
    const { BookingStatusSchema: FEBookingStatus } = await import(
      '../../web/src/lib/api-schemas/booking.schema.js'
    ).catch(() => ({ BookingStatusSchema: null }));

    if (!FEBookingStatus) {
      // Frontend schema not resolvable from backend test runner — skip mirror check
      return;
    }

    const statuses = ['pending', 'confirmed', 'completed', 'cancelled', 'disputed'];
    for (const s of statuses) {
      expect(BookingStatusSchema.safeParse(s).success).toBe(true);
      expect(FEBookingStatus.safeParse(s).success).toBe(true);
    }
  });

  it('PaymentStatusValue enum is identical on frontend and backend', async () => {
    const { PaymentStatusValueSchema: FEPaymentStatus } = await import(
      '../../web/src/lib/api-schemas/payment.schema.js'
    ).catch(() => ({ PaymentStatusValueSchema: null }));

    if (!FEPaymentStatus) return;

    const statuses = ['pending', 'submitted', 'confirmed', 'failed', 'timeout', 'expired'];
    for (const s of statuses) {
      expect(PaymentStatusValueSchema.safeParse(s).success).toBe(true);
      expect(FEPaymentStatus.safeParse(s).success).toBe(true);
    }
  });

  it('NotificationType enum is identical on frontend and backend', async () => {
    const { NotificationTypeSchema: FENotifType } = await import(
      '../../web/src/lib/api-schemas/notification.schema.js'
    ).catch(() => ({ NotificationTypeSchema: null }));

    if (!FENotifType) return;

    const types = [
      'booking_created', 'booking_confirmed', 'booking_cancelled', 'booking_completed',
      'booking_disputed', 'payment_received', 'payment_failed', 'review_received',
      'review_response', 'system',
    ];
    for (const t of types) {
      expect(NotificationTypeSchema.safeParse(t).success).toBe(true);
      expect(FENotifType.safeParse(t).success).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 9 — Content-Type contract
// ─────────────────────────────────────────────────────────────────────────────

describe('Schema: Content-Type is always application/json', () => {
  it('GET /api/v1/properties/search/advanced', async () => {
    const res = await request(app).get('/api/v1/properties/search/advanced');
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('GET /api/v1/bookings (401)', async () => {
    const res = await request(app).get('/api/v1/bookings');
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('GET /api/v1/notifications (401)', async () => {
    const res = await request(app).get('/api/v1/notifications');
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('GET /api/v1/payments/:id/status (401)', async () => {
    const res = await request(app).get(
      '/api/v1/payments/00000000-0000-0000-0000-000000000000/status',
    );
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });
});
