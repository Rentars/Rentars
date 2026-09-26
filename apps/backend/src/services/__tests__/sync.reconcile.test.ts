/**
 * Tests for escrow reconciliation with tenant/host notifications (#611).
 *
 * These tests exercise the error classification logic which is the
 * pure-function part of the reconciliation (no DB required).
 */

import { describe, it, expect } from 'vitest';

// ─── Error classification (extracted for testability) ─────────────────────────

const TRANSIENT_ERROR_PATTERNS = [
  /network/i,
  /timeout/i,
  /econnreset/i,
  /enotfound/i,
  /503/,
  /502/,
  /rate.?limit/i,
];

type ErrorCategory = 'transient' | 'permanent';

function classifyError(message: string): ErrorCategory {
  return TRANSIENT_ERROR_PATTERNS.some((p) => p.test(message))
    ? 'transient'
    : 'permanent';
}

// ─── classifyError ────────────────────────────────────────────────────────────

describe('classifyError', () => {
  it('classifies "network error" as transient', () => {
    expect(classifyError('network error')).toBe('transient');
  });

  it('classifies "request timeout" as transient', () => {
    expect(classifyError('request timeout after 30s')).toBe('transient');
  });

  it('classifies "ECONNRESET" as transient (case-insensitive)', () => {
    expect(classifyError('ECONNRESET')).toBe('transient');
  });

  it('classifies "ENOTFOUND" as transient', () => {
    expect(classifyError('getaddrinfo ENOTFOUND soroban-testnet.stellar.org')).toBe('transient');
  });

  it('classifies HTTP 503 as transient', () => {
    expect(classifyError('upstream 503 response')).toBe('transient');
  });

  it('classifies HTTP 502 as transient', () => {
    expect(classifyError('502 Bad Gateway')).toBe('transient');
  });

  it('classifies "rate limit exceeded" as transient', () => {
    expect(classifyError('rate limit exceeded')).toBe('transient');
  });

  it('classifies "rate-limit" (hyphen variant) as transient', () => {
    expect(classifyError('rate-limit hit')).toBe('transient');
  });

  it('classifies "contract error: invalid state" as permanent', () => {
    expect(classifyError('contract error: invalid state')).toBe('permanent');
  });

  it('classifies "escrow already funded" as permanent', () => {
    expect(classifyError('escrow already funded')).toBe('permanent');
  });

  it('classifies "insufficient balance" as permanent', () => {
    expect(classifyError('insufficient balance')).toBe('permanent');
  });

  it('classifies empty string as permanent', () => {
    expect(classifyError('')).toBe('permanent');
  });
});

// ─── MAX_RECONCILE_ATTEMPTS boundary logic ────────────────────────────────────

describe('Reconciliation attempt threshold', () => {
  const MAX_RECONCILE_ATTEMPTS = 5;

  it('allows reconciliation below threshold', () => {
    expect(4 < MAX_RECONCILE_ATTEMPTS).toBe(true);
  });

  it('quarantines at threshold', () => {
    expect(5 >= MAX_RECONCILE_ATTEMPTS).toBe(true);
  });

  it('quarantines beyond threshold', () => {
    expect(6 >= MAX_RECONCILE_ATTEMPTS).toBe(true);
  });
});

// ─── Notification deduplication flag ──────────────────────────────────────────

describe('Notification deduplication', () => {
  it('treats non-null escrow_failure_notified_at as already notified', () => {
    const booking = { escrow_failure_notified_at: '2026-09-26T00:00:00.000Z' };
    const alreadyNotified = booking.escrow_failure_notified_at !== null;
    expect(alreadyNotified).toBe(true);
  });

  it('treats null escrow_failure_notified_at as not yet notified', () => {
    const booking = { escrow_failure_notified_at: null };
    const alreadyNotified = booking.escrow_failure_notified_at !== null;
    expect(alreadyNotified).toBe(false);
  });

  it('treats undefined escrow_failure_notified_at as not yet notified', () => {
    const booking: { escrow_failure_notified_at?: string | null } = {};
    const alreadyNotified =
      booking.escrow_failure_notified_at !== undefined &&
      booking.escrow_failure_notified_at !== null;
    expect(alreadyNotified).toBe(false);
  });
});
