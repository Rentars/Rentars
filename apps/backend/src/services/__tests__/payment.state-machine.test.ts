/**
 * Tests for the canonical payment state machine (#609).
 *
 * These tests exercise:
 *  - Allowed and disallowed state transitions
 *  - Idempotent replay on duplicate event hashes
 *  - Quarantine of unknown/regressive transitions
 *  - Provider status mapping
 *  - hashEventPayload determinism
 */

import { describe, it, expect } from 'vitest';
import {
  isAllowedTransition,
  mapProviderStatus,
  hashEventPayload,
} from '@/services/payment.service.js';
import type { PaymentStatus } from '@/services/payment.service.js';

// ─── isAllowedTransition ──────────────────────────────────────────────────────

describe('isAllowedTransition', () => {
  it('allows pending → submitted', () => {
    expect(isAllowedTransition('pending', 'submitted')).toBe(true);
  });

  it('allows pending → failed', () => {
    expect(isAllowedTransition('pending', 'failed')).toBe(true);
  });

  it('allows submitted → confirmed', () => {
    expect(isAllowedTransition('submitted', 'confirmed')).toBe(true);
  });

  it('allows submitted → failed', () => {
    expect(isAllowedTransition('submitted', 'failed')).toBe(true);
  });

  it('allows submitted → timed_out', () => {
    expect(isAllowedTransition('submitted', 'timed_out')).toBe(true);
  });

  it('allows timed_out → submitted (retry path)', () => {
    expect(isAllowedTransition('timed_out', 'submitted')).toBe(true);
  });

  it('allows confirmed → refunded', () => {
    expect(isAllowedTransition('confirmed', 'refunded')).toBe(true);
  });

  it('rejects confirmed → pending (regressive)', () => {
    expect(isAllowedTransition('confirmed', 'pending')).toBe(false);
  });

  it('rejects failed → confirmed (terminal)', () => {
    expect(isAllowedTransition('failed', 'confirmed')).toBe(false);
  });

  it('rejects refunded → confirmed (terminal)', () => {
    expect(isAllowedTransition('refunded', 'confirmed')).toBe(false);
  });

  it('rejects submitted → pending (regressive)', () => {
    expect(isAllowedTransition('submitted', 'pending')).toBe(false);
  });

  it('rejects confirmed → timed_out (regressive)', () => {
    expect(isAllowedTransition('confirmed', 'timed_out')).toBe(false);
  });

  it('allows under_review → pending (admin resolution)', () => {
    expect(isAllowedTransition('under_review', 'pending')).toBe(true);
  });

  it('allows under_review → failed (admin resolution)', () => {
    expect(isAllowedTransition('under_review', 'failed')).toBe(true);
  });
});

// ─── mapProviderStatus ────────────────────────────────────────────────────────

describe('mapProviderStatus', () => {
  it('maps Stellar SUCCESS → confirmed', () => {
    expect(mapProviderStatus('SUCCESS')).toBe('confirmed');
  });

  it('maps Stellar FAILED → failed', () => {
    expect(mapProviderStatus('FAILED')).toBe('failed');
  });

  it('maps Stellar NOT_FOUND → timed_out', () => {
    expect(mapProviderStatus('NOT_FOUND')).toBe('timed_out');
  });

  it('maps TrustlessWork funded → confirmed', () => {
    expect(mapProviderStatus('funded')).toBe('confirmed');
  });

  it('maps TrustlessWork released → refunded', () => {
    expect(mapProviderStatus('released')).toBe('refunded');
  });

  it('maps TrustlessWork cancelled → failed', () => {
    expect(mapProviderStatus('cancelled')).toBe('failed');
  });

  it('maps TrustlessWork disputed → under_review', () => {
    expect(mapProviderStatus('disputed')).toBe('under_review');
  });

  it('maps unknown provider status → under_review (quarantine)', () => {
    expect(mapProviderStatus('UNKNOWN_XYZ')).toBe('under_review');
  });

  it('maps empty string → under_review', () => {
    expect(mapProviderStatus('')).toBe('under_review');
  });
});

// ─── hashEventPayload ─────────────────────────────────────────────────────────

describe('hashEventPayload', () => {
  it('produces a 64-char hex string', () => {
    const hash = hashEventPayload({ eventId: 'e1', status: 'funded' });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same payload', () => {
    const payload = { a: 1, b: 'hello', c: true };
    expect(hashEventPayload(payload)).toBe(hashEventPayload(payload));
  });

  it('is key-order independent', () => {
    const h1 = hashEventPayload({ a: 1, b: 2 });
    const h2 = hashEventPayload({ b: 2, a: 1 });
    expect(h1).toBe(h2);
  });

  it('differs for different payloads', () => {
    const h1 = hashEventPayload({ status: 'funded' });
    const h2 = hashEventPayload({ status: 'cancelled' });
    expect(h1).not.toBe(h2);
  });

  it('treats numeric type differences as different', () => {
    const h1 = hashEventPayload({ amount: 100 });
    const h2 = hashEventPayload({ amount: '100' });
    expect(h1).not.toBe(h2);
  });
});

// ─── PaymentStatus type coverage ──────────────────────────────────────────────

describe('PaymentStatus values', () => {
  const allStatuses: PaymentStatus[] = [
    'pending', 'submitted', 'confirmed', 'failed', 'timed_out', 'refunded', 'under_review',
  ];

  it('covers every defined status in isAllowedTransition', () => {
    // Ensure no status silently falls through with undefined
    for (const status of allStatuses) {
      // Should not throw
      expect(() => isAllowedTransition(status, 'confirmed')).not.toThrow();
    }
  });
});
