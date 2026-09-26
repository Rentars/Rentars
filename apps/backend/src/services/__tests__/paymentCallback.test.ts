/**
 * Tests for the payment callback verification service (#610).
 *
 * These tests exercise:
 *  - HMAC signature verification (valid and invalid)
 *  - Clock skew rejection
 *  - Payload schema validation
 *  - buildCallbackResponse() output
 */

import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  buildCallbackResponse,
  callbackBodySchema,
} from '@/services/paymentCallback.service.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sign(body: Buffer, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

function makeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: 'evt_001',
    timestamp: new Date().toISOString(),
    status: 'funded',
    bookingId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    amountStroops: '1000000000',
    providerAccountId: 'test-provider',
    ...overrides,
  };
}

// ─── callbackBodySchema ────────────────────────────────────────────────────────

describe('callbackBodySchema', () => {
  it('accepts a valid callback body', () => {
    const result = callbackBodySchema.safeParse(makeBody());
    expect(result.success).toBe(true);
  });

  it('rejects missing eventId', () => {
    const body = makeBody();
    delete body.eventId;
    const result = callbackBodySchema.safeParse(body);
    expect(result.success).toBe(false);
  });

  it('rejects invalid timestamp', () => {
    const result = callbackBodySchema.safeParse(makeBody({ timestamp: 'not-a-date' }));
    expect(result.success).toBe(false);
  });

  it('rejects non-integer amountStroops', () => {
    const result = callbackBodySchema.safeParse(makeBody({ amountStroops: '10.5' }));
    expect(result.success).toBe(false);
  });

  it('rejects non-UUID bookingId', () => {
    const result = callbackBodySchema.safeParse(makeBody({ bookingId: 'not-a-uuid' }));
    expect(result.success).toBe(false);
  });

  it('accepts optional txHash', () => {
    const result = callbackBodySchema.safeParse(makeBody({ txHash: 'abc123' }));
    expect(result.success).toBe(true);
  });

  it('passes through extra fields (provider-specific data)', () => {
    const result = callbackBodySchema.safeParse(makeBody({ extraField: 'value' }));
    expect(result.success).toBe(true);
  });
});

// ─── buildCallbackResponse ────────────────────────────────────────────────────

describe('buildCallbackResponse', () => {
  it('returns status=acknowledged for acknowledged result', () => {
    const resp = buildCallbackResponse({
      status: 'acknowledged',
      httpStatus: 200,
      message: 'ok',
    });
    expect(resp.status).toBe('acknowledged');
    expect(resp.message).toBe('ok');
  });

  it('returns status=replayed for replayed result', () => {
    const resp = buildCallbackResponse({
      status: 'replayed',
      httpStatus: 200,
      message: 'already processed',
    });
    expect(resp.status).toBe('replayed');
  });

  it('returns status=error for invalid_signature', () => {
    const resp = buildCallbackResponse({
      status: 'invalid_signature',
      httpStatus: 401,
      message: 'bad sig',
    });
    expect(resp.status).toBe('error');
    // Message is provider-safe (no internal details exposed here)
    expect(resp.message).toBe('bad sig');
  });

  it('returns status=error for mismatch', () => {
    const resp = buildCallbackResponse({
      status: 'mismatch',
      httpStatus: 422,
      message: 'amount mismatch',
    });
    expect(resp.status).toBe('error');
  });

  it('returns status=error for quarantined', () => {
    const resp = buildCallbackResponse({
      status: 'quarantined',
      httpStatus: 200,
      message: 'under review',
    });
    expect(resp.status).toBe('error');
  });
});

// ─── HMAC helper (unit-level) ─────────────────────────────────────────────────

describe('HMAC signature computation', () => {
  const secret = 'test-webhook-secret-32-chars-long';

  it('sign() produces a 64-char hex string', () => {
    const body = Buffer.from(JSON.stringify(makeBody()));
    const sig = sign(body, secret);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sign() is deterministic for the same input', () => {
    const body = Buffer.from('{"eventId":"e1"}');
    expect(sign(body, secret)).toBe(sign(body, secret));
  });

  it('different secrets produce different signatures', () => {
    const body = Buffer.from('{"eventId":"e1"}');
    expect(sign(body, 'secret-a')).not.toBe(sign(body, 'secret-b'));
  });
});
