/**
 * Payment provider circuit breaker (#618 / Issue 050).
 *
 * States:
 *   closed     — normal; calls pass through
 *   open       — provider error rate exceeded; new external calls rejected
 *   half_open  — after cooldown, allow a probe call
 *
 * In-flight payments are never cancelled when the circuit opens; only new
 * external submit/escrow calls are blocked. Operators can inspect and reset
 * via admin endpoints.
 */

import { supabase } from '@/config/supabase.js';

export type CircuitState = 'closed' | 'open' | 'half_open';
export type PaymentProvider = 'stellar_horizon' | 'trustless_work' | 'soroban_rpc';

export interface CircuitSnapshot {
  provider: PaymentProvider | string;
  state: CircuitState;
  failureCount: number;
  successCount: number;
  openedAt: string | null;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  resetAt: string | null;
  updatedAt: string;
  /** Seconds until a probe is allowed when open. */
  retryAfterSeconds: number;
}

export interface CircuitConfig {
  /** Consecutive failures that open the circuit. */
  failureThreshold: number;
  /** Milliseconds the circuit stays open before half-open probe. */
  openCooldownMs: number;
  /** Successes in half-open required to close. */
  halfOpenSuccesses: number;
}

const DEFAULT_CONFIG: CircuitConfig = {
  failureThreshold: Number(process.env.PAYMENT_CIRCUIT_FAILURE_THRESHOLD ?? 5),
  openCooldownMs: Number(process.env.PAYMENT_CIRCUIT_COOLDOWN_MS ?? 30_000),
  halfOpenSuccesses: Number(process.env.PAYMENT_CIRCUIT_HALF_OPEN_SUCCESSES ?? 2),
};

/** In-memory fallback when DB is unavailable (tests / local). */
const memoryCircuits = new Map<string, CircuitSnapshot>();

function emptySnapshot(provider: string): CircuitSnapshot {
  return {
    provider,
    state: 'closed',
    failureCount: 0,
    successCount: 0,
    openedAt: null,
    lastFailureAt: null,
    lastSuccessAt: null,
    lastError: null,
    resetAt: null,
    updatedAt: new Date().toISOString(),
    retryAfterSeconds: 0,
  };
}

function withRetryAfter(snap: CircuitSnapshot, config: CircuitConfig = DEFAULT_CONFIG): CircuitSnapshot {
  if (snap.state !== 'open' || !snap.openedAt) {
    return { ...snap, retryAfterSeconds: 0 };
  }
  const elapsed = Date.now() - new Date(snap.openedAt).getTime();
  const remaining = Math.max(0, config.openCooldownMs - elapsed);
  return { ...snap, retryAfterSeconds: Math.ceil(remaining / 1000) };
}

async function loadCircuit(provider: string): Promise<CircuitSnapshot> {
  try {
    const { data, error } = await supabase
      .from('payment_circuit_state')
      .select('*')
      .eq('provider', provider)
      .maybeSingle();

    if (error || !data) {
      return memoryCircuits.get(provider) ?? emptySnapshot(provider);
    }

    return withRetryAfter({
      provider: data.provider,
      state: data.state as CircuitState,
      failureCount: data.failure_count ?? 0,
      successCount: data.success_count ?? 0,
      openedAt: data.opened_at ?? null,
      lastFailureAt: data.last_failure_at ?? null,
      lastSuccessAt: data.last_success_at ?? null,
      lastError: data.last_error ?? null,
      resetAt: data.reset_at ?? null,
      updatedAt: data.updated_at ?? new Date().toISOString(),
      retryAfterSeconds: 0,
    });
  } catch {
    return memoryCircuits.get(provider) ?? emptySnapshot(provider);
  }
}

async function saveCircuit(snap: CircuitSnapshot): Promise<void> {
  memoryCircuits.set(snap.provider, snap);
  try {
    await supabase.from('payment_circuit_state').upsert(
      {
        provider: snap.provider,
        state: snap.state,
        failure_count: snap.failureCount,
        success_count: snap.successCount,
        opened_at: snap.openedAt,
        last_failure_at: snap.lastFailureAt,
        last_success_at: snap.lastSuccessAt,
        last_error: snap.lastError,
        reset_at: snap.resetAt,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'provider' },
    );
  } catch {
    // Memory store remains authoritative for this process.
  }
}

/**
 * Evaluate whether a new external call to `provider` is allowed.
 * Advances open → half_open after cooldown.
 */
export async function allowPaymentCall(
  provider: PaymentProvider | string,
  config: CircuitConfig = DEFAULT_CONFIG,
): Promise<{ allowed: boolean; circuit: CircuitSnapshot; reason?: string }> {
  let circuit = await loadCircuit(provider);

  if (circuit.state === 'open') {
    const openedMs = circuit.openedAt ? new Date(circuit.openedAt).getTime() : 0;
    if (Date.now() - openedMs >= config.openCooldownMs) {
      circuit = {
        ...circuit,
        state: 'half_open',
        successCount: 0,
        updatedAt: new Date().toISOString(),
      };
      await saveCircuit(circuit);
      return { allowed: true, circuit: withRetryAfter(circuit, config) };
    }

    const withRetry = withRetryAfter(circuit, config);
    return {
      allowed: false,
      circuit: withRetry,
      reason: `Payment provider circuit open for ${provider}. Retry after ${withRetry.retryAfterSeconds}s.`,
    };
  }

  return { allowed: true, circuit: withRetryAfter(circuit, config) };
}

/** Record a successful provider call; closes the circuit from half-open when enough successes land. */
export async function recordProviderSuccess(
  provider: PaymentProvider | string,
  config: CircuitConfig = DEFAULT_CONFIG,
): Promise<CircuitSnapshot> {
  const current = await loadCircuit(provider);
  const now = new Date().toISOString();

  let next: CircuitSnapshot;
  if (current.state === 'half_open') {
    const successes = current.successCount + 1;
    next = {
      ...current,
      successCount: successes,
      failureCount: 0,
      lastSuccessAt: now,
      updatedAt: now,
      state: successes >= config.halfOpenSuccesses ? 'closed' : 'half_open',
      openedAt: successes >= config.halfOpenSuccesses ? null : current.openedAt,
    };
  } else {
    next = {
      ...current,
      state: 'closed',
      failureCount: 0,
      successCount: current.successCount + 1,
      lastSuccessAt: now,
      updatedAt: now,
      openedAt: null,
    };
  }

  await saveCircuit(next);
  return withRetryAfter(next, config);
}

/** Record a provider failure; opens the circuit when the threshold is hit. */
export async function recordProviderFailure(
  provider: PaymentProvider | string,
  errorMessage: string,
  config: CircuitConfig = DEFAULT_CONFIG,
): Promise<CircuitSnapshot> {
  const current = await loadCircuit(provider);
  const now = new Date().toISOString();
  const failures = current.failureCount + 1;
  const shouldOpen =
    current.state === 'half_open' || failures >= config.failureThreshold;

  const next: CircuitSnapshot = {
    ...current,
    failureCount: failures,
    lastFailureAt: now,
    lastError: errorMessage.slice(0, 500),
    updatedAt: now,
    state: shouldOpen ? 'open' : current.state,
    openedAt: shouldOpen ? now : current.openedAt,
    successCount: shouldOpen ? 0 : current.successCount,
  };

  await saveCircuit(next);
  return withRetryAfter(next, config);
}

/** Operator reset — forces closed and clears counters. */
export async function resetCircuit(
  provider: PaymentProvider | string,
): Promise<CircuitSnapshot> {
  const next: CircuitSnapshot = {
    ...emptySnapshot(provider),
    resetAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await saveCircuit(next);
  return next;
}

/** List all known circuits (DB + memory). */
export async function listCircuits(): Promise<CircuitSnapshot[]> {
  const providers: string[] = ['stellar_horizon', 'trustless_work', 'soroban_rpc'];
  try {
    const { data } = await supabase.from('payment_circuit_state').select('provider');
    if (data) {
      for (const row of data) {
        if (!providers.includes(row.provider)) providers.push(row.provider);
      }
    }
  } catch {
    // fall through with defaults
  }
  for (const key of memoryCircuits.keys()) {
    if (!providers.includes(key)) providers.push(key);
  }
  return Promise.all(providers.map((p) => loadCircuit(p).then((c) => withRetryAfter(c))));
}

/** Test helper — clear in-memory circuits. */
export function _resetMemoryCircuitsForTests(): void {
  memoryCircuits.clear();
}
