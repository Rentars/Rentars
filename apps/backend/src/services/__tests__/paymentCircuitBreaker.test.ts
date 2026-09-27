/**
 * #618 — Payment circuit breakers and attempt limits.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';

const mockFrom = mock(() => ({
  select: () => ({
    eq: () => ({
      maybeSingle: async () => ({ data: null, error: null }),
    }),
  }),
  upsert: async () => ({ error: null }),
}));

mock.module('../../config/supabase.js', () => ({
  supabase: { from: mockFrom },
}));

const {
  allowPaymentCall,
  recordProviderFailure,
  recordProviderSuccess,
  resetCircuit,
  listCircuits,
  _resetMemoryCircuitsForTests,
} = await import('../paymentCircuitBreaker.service.js');

const {
  gatePaymentAttempt,
  enqueuePaymentWork,
  getPaymentQueueStats,
  _resetAttemptCountersForTests,
} = await import('../paymentAttemptLimiter.service.js');

describe('paymentCircuitBreaker (#618)', () => {
  beforeEach(() => {
    _resetMemoryCircuitsForTests();
  });

  it('stays closed under the failure threshold', async () => {
    await recordProviderFailure('stellar_horizon', 'timeout', {
      failureThreshold: 5,
      openCooldownMs: 30_000,
      halfOpenSuccesses: 2,
    });
    const gate = await allowPaymentCall('stellar_horizon', {
      failureThreshold: 5,
      openCooldownMs: 30_000,
      halfOpenSuccesses: 2,
    });
    expect(gate.allowed).toBe(true);
    expect(gate.circuit.state).toBe('closed');
  });

  it('opens after repeated failures and returns retry-after', async () => {
    const config = { failureThreshold: 3, openCooldownMs: 60_000, halfOpenSuccesses: 2 };
    for (let i = 0; i < 3; i++) {
      await recordProviderFailure('trustless_work', `err-${i}`, config);
    }
    const gate = await allowPaymentCall('trustless_work', config);
    expect(gate.allowed).toBe(false);
    expect(gate.circuit.state).toBe('open');
    expect(gate.circuit.retryAfterSeconds).toBeGreaterThan(0);
    expect(gate.reason).toContain('circuit open');
  });

  it('allows operator reset to closed', async () => {
    const config = { failureThreshold: 1, openCooldownMs: 60_000, halfOpenSuccesses: 1 };
    await recordProviderFailure('soroban_rpc', 'boom', config);
    expect((await allowPaymentCall('soroban_rpc', config)).allowed).toBe(false);

    const reset = await resetCircuit('soroban_rpc');
    expect(reset.state).toBe('closed');
    expect(reset.failureCount).toBe(0);
    expect((await allowPaymentCall('soroban_rpc', config)).allowed).toBe(true);
  });

  it('closes from half-open after enough successes', async () => {
    const config = { failureThreshold: 1, openCooldownMs: 0, halfOpenSuccesses: 2 };
    await recordProviderFailure('stellar_horizon', 'down', config);
    const probe = await allowPaymentCall('stellar_horizon', config);
    expect(probe.allowed).toBe(true);
    expect(probe.circuit.state).toBe('half_open');

    await recordProviderSuccess('stellar_horizon', config);
    const mid = await allowPaymentCall('stellar_horizon', config);
    expect(mid.circuit.state).toBe('half_open');

    await recordProviderSuccess('stellar_horizon', config);
    const closed = await allowPaymentCall('stellar_horizon', config);
    expect(closed.circuit.state).toBe('closed');
  });

  it('lists circuits for operators', async () => {
    const circuits = await listCircuits();
    expect(circuits.length).toBeGreaterThanOrEqual(3);
  });
});

describe('paymentAttemptLimiter (#618)', () => {
  beforeEach(() => {
    _resetAttemptCountersForTests();
  });

  it('enforces per-booking attempt limits with retry-after', async () => {
    const config = { maxPerUser: 10, maxPerBooking: 2, windowMs: 60_000 };
    expect((await gatePaymentAttempt('u1', 'b1', 'key-1', config)).allowed).toBe(true);
    expect((await gatePaymentAttempt('u1', 'b1', 'key-2', config)).allowed).toBe(true);
    const blocked = await gatePaymentAttempt('u1', 'b1', 'key-3', config);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.reason).toContain('Per-booking');
  });

  it('enforces per-user attempt limits across bookings', async () => {
    const config = { maxPerUser: 2, maxPerBooking: 10, windowMs: 60_000 };
    await gatePaymentAttempt('u2', 'b-a', undefined, config);
    await gatePaymentAttempt('u2', 'b-b', undefined, config);
    const blocked = await gatePaymentAttempt('u2', 'b-c', undefined, config);
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain('Per-user');
  });

  it('runs confirm work under backpressure and reports queue stats', async () => {
    const result = await enqueuePaymentWork(async () => 42);
    expect(result).toBe(42);
    const stats = getPaymentQueueStats();
    expect(stats.depth).toBe(0);
    expect(stats.maxDepth).toBeGreaterThan(0);
  });
});
