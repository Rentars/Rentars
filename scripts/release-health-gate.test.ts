import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  EXIT_CODES,
  evaluate,
  evaluateMode,
  evaluateResume,
  parsePolicy,
  parseSnapshot,
} from './release-health-gate';

const policy = parsePolicy(
  JSON.parse(readFileSync(resolve(import.meta.dir, '../docs/releases/health-gates.json'), 'utf-8'))
);

const healthy = {
  error_rate: [0.01, 0.01],
  latency_p99_ms: [200, 300],
  transaction_failure_ratio: [0, 0.001],
  db_pool_usage_ratio: [0.4],
  redis_evictions_per_second: [0],
  contract_invocation_failure_ratio: [0, 0],
};

function withMetric(name: string, values: number[]) {
  return { ...healthy, [name]: values };
}

// Five windows (the longest recovery rule in the policy) at or below every
// recovery threshold.
const recovered = {
  error_rate: [0.01, 0.01, 0.01, 0.01, 0.01],
  latency_p99_ms: [300, 300, 300, 300, 300],
  transaction_failure_ratio: [0, 0, 0, 0, 0],
  db_pool_usage_ratio: [0.5, 0.5, 0.5, 0.5, 0.5],
  redis_evictions_per_second: [0, 0, 0, 0, 0],
  contract_invocation_failure_ratio: [0, 0, 0, 0, 0],
};

describe('release health gate: evaluate', () => {
  it('proceeds when every gate is within threshold', () => {
    const result = evaluate(policy, healthy);
    expect(result.decision).toBe('proceed');
    expect(result.gates.every((g) => g.status === 'ok')).toBe(true);
  });

  it('pauses when the error rate breaches for two consecutive windows', () => {
    const result = evaluate(policy, withMetric('error_rate', [0.01, 0.06, 0.08]));
    expect(result.decision).toBe('pause');
    expect(result.gates.find((g) => g.name === 'error_rate')?.status).toBe('breached');
  });

  it('does not breach a two-window gate on a single high window', () => {
    const result = evaluate(policy, withMetric('error_rate', [0.09, 0.01]));
    expect(result.decision).toBe('proceed');
  });

  it('rolls back when transaction failures breach', () => {
    const result = evaluate(policy, withMetric('transaction_failure_ratio', [0.03, 0.04]));
    expect(result.decision).toBe('rollback');
  });

  it('rolls back in preference to pausing when both kinds breach', () => {
    const result = evaluate(policy, {
      ...withMetric('error_rate', [0.2, 0.2]),
      ...{ contract_invocation_failure_ratio: [0.5, 0.5] },
    });
    expect(result.decision).toBe('rollback');
  });

  it('fails closed to pause when a gate has no data', () => {
    const { error_rate: _omitted, ...withoutErrorRate } = healthy;
    const result = evaluate(policy, withoutErrorRate);
    expect(result.decision).toBe('pause');
    expect(result.gates.find((g) => g.name === 'error_rate')?.status).toBe('insufficient_data');
  });

  it('fails closed to pause when a gate has fewer windows than required', () => {
    const result = evaluate(policy, withMetric('error_rate', [0.01]));
    expect(result.decision).toBe('pause');
  });

  it('pauses on pool exhaustion after a single window', () => {
    const result = evaluate(policy, withMetric('db_pool_usage_ratio', [0.95]));
    expect(result.decision).toBe('pause');
  });
});

describe('release health gate: resume', () => {
  it('allows resume once every recovery rule has held for its windows', () => {
    const result = evaluateResume(policy, recovered);
    expect(result.decision).toBe('proceed');
  });

  it('keeps a paused rollout paused while recovery is incomplete', () => {
    const result = evaluateResume(policy, {
      ...recovered,
      error_rate: [0.01, 0.01, 0.03, 0.01, 0.01],
    });
    expect(result.decision).toBe('pause');
    expect(result.gates.find((g) => g.name === 'error_rate')?.status).toBe('recovering');
  });

  it('holds when there are fewer recovery windows than the policy requires', () => {
    const result = evaluateResume(policy, { ...recovered, error_rate: [0.01, 0.01] });
    expect(result.decision).toBe('pause');
    expect(result.gates.find((g) => g.name === 'error_rate')?.status).toBe('recovering');
  });

  it('never resumes while a rollback gate is breached', () => {
    const result = evaluateResume(policy, {
      ...recovered,
      transaction_failure_ratio: [0.05, 0.05, 0.05, 0.05, 0.05],
    });
    expect(result.decision).toBe('rollback');
  });

  it('dispatches on mode', () => {
    expect(evaluateMode(policy, recovered, 'resume').decision).toBe('proceed');
    expect(evaluateMode(policy, recovered, 'evaluate').decision).toBe('proceed');
    expect(
      evaluateMode(policy, { ...recovered, error_rate: [0.01, 0.01, 0.01, 0.01, 0.2] }, 'resume')
        .decision
    ).toBe('pause');
  });
});

describe('release health gate: exit codes', () => {
  it('maps decisions to the documented exit codes', () => {
    expect(EXIT_CODES).toEqual({ proceed: 0, pause: 10, rollback: 20 });
  });
});

describe('release health gate: input validation', () => {
  it('rejects a policy without gates', () => {
    expect(() => parsePolicy({ policy_version: '1' })).toThrow('gates array');
  });

  it('rejects an unknown action', () => {
    const bad = {
      policy_version: '1',
      gates: [{ name: 'x', threshold: 1, consecutive_windows: 1, action: 'page', recovery: null }],
    };
    expect(() => parsePolicy(bad)).toThrow('action must be');
  });

  it('rejects a snapshot with non-numeric samples', () => {
    expect(() => parseSnapshot({ error_rate: [0.01, 'high'] })).toThrow('finite numbers');
  });

  it('rejects a snapshot that is not an object', () => {
    expect(() => parseSnapshot([0.01])).toThrow('JSON object');
  });

  it('ships a policy whose gates cover every documented metric', () => {
    const names = policy.gates.map((g) => g.name).sort();
    expect(names).toEqual([
      'contract_invocation_failure_ratio',
      'db_pool_usage_ratio',
      'error_rate',
      'latency_p99_ms',
      'redis_evictions_per_second',
      'transaction_failure_ratio',
    ]);
  });
});
#!/usr/bin/env bun
/**
 * Release health gate (#737).
 *
 * Evaluates a metrics snapshot against docs/releases/health-gates.json and
 * prints the rollout decision as JSON. The deployment pipeline acts on the exit
 * code:
 *
 *   0   proceed    every gate is within its threshold
 *   10  pause      a pause gate is breached, or a gate has too little data
 *   20  rollback   a rollback gate is breached
 *   1   error      invalid policy or snapshot
 *
 * Missing or short metric data pauses the rollout. The gate fails closed rather
 * than assuming health.
 *
 * Usage:
 *   bun run scripts/release-health-gate.ts --metrics <snapshot.json>
 *     [--policy <file>] [--mode evaluate|resume]
 *
 * Snapshot format: { "<gate name>": [value, ...] }, one value per one-minute
 * window, oldest first.
 *
 * --mode evaluate (default) answers "is this release healthy right now?".
 * --mode resume answers "may a paused rollout continue?". Every gate that has a
 * recovery rule must be at or below its recovery threshold for its recovery
 * windows, and no gate may be breached. The snapshot does not record which gate
 * paused the rollout, so the check applies to all of them.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type GateAction = 'pause' | 'rollback';
export type Decision = 'proceed' | 'pause' | 'rollback';
export type Mode = 'evaluate' | 'resume';

export interface Recovery {
  threshold: number;
  windows: number;
}

export interface Gate {
  name: string;
  threshold: number;
  consecutive_windows: number;
  action: GateAction;
  recovery: Recovery | null;
}

export interface Policy {
  policy_version: string;
  gates: Gate[];
}

export type Snapshot = Record<string, number[]>;

export type GateStatus = 'ok' | 'breached' | 'insufficient_data' | 'recovering';

export interface GateResult {
  name: string;
  action: GateAction;
  status: GateStatus;
  threshold: number;
  observed: number[];
}

export interface Evaluation {
  decision: Decision;
  gates: GateResult[];
}

export const EXIT_CODES: Record<Decision, number> = {
  proceed: 0,
  pause: 10,
  rollback: 20,
};

const ERROR_EXIT_CODE = 1;

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parsePolicy(raw: unknown): Policy {
  if (!isRecord(raw) || typeof raw.policy_version !== 'string' || !Array.isArray(raw.gates)) {
    fail('policy must contain policy_version and a gates array');
  }

  const gates = raw.gates.map((entry, index): Gate => {
    if (!isRecord(entry)) fail(`gates[${index}] must be an object`);
    const { name, threshold, consecutive_windows, action, recovery } = entry;
    if (typeof name !== 'string' || name === '')
      fail(`gates[${index}].name must be a non-empty string`);
    if (typeof threshold !== 'number' || !Number.isFinite(threshold)) {
      fail(`gate ${String(name)} threshold must be a finite number`);
    }
    if (!Number.isInteger(consecutive_windows) || (consecutive_windows as number) < 1) {
      fail(`gate ${String(name)} consecutive_windows must be an integer >= 1`);
    }
    if (action !== 'pause' && action !== 'rollback') {
      fail(`gate ${String(name)} action must be "pause" or "rollback"`);
    }

    let parsedRecovery: Recovery | null = null;
    if (recovery !== null && recovery !== undefined) {
      if (
        !isRecord(recovery) ||
        typeof recovery.threshold !== 'number' ||
        !Number.isInteger(recovery.windows)
      ) {
        fail(`gate ${String(name)} recovery must have a numeric threshold and integer windows`);
      }
      parsedRecovery = {
        threshold: recovery.threshold as number,
        windows: recovery.windows as number,
      };
    }

    return {
      name: name as string,
      threshold,
      consecutive_windows: consecutive_windows as number,
      action,
      recovery: parsedRecovery,
    };
  });

  return { policy_version: raw.policy_version, gates };
}

export function parseSnapshot(raw: unknown): Snapshot {
  if (!isRecord(raw)) fail('metrics snapshot must be a JSON object keyed by gate name');

  const snapshot: Snapshot = {};
  for (const [name, values] of Object.entries(raw)) {
    if (
      !Array.isArray(values) ||
      !values.every((v) => typeof v === 'number' && Number.isFinite(v))
    ) {
      fail(`metric ${name} must be an array of finite numbers`);
    }
    snapshot[name] = values as number[];
  }
  return snapshot;
}

/**
 * Evaluates the rollout. A gate is breached when its most recent
 * `consecutive_windows` values are all above the threshold.
 */
export function evaluate(policy: Policy, snapshot: Snapshot): Evaluation {
  const gates = policy.gates.map((gate): GateResult => {
    const values = snapshot[gate.name] ?? [];
    if (values.length < gate.consecutive_windows) {
      return {
        name: gate.name,
        action: gate.action,
        status: 'insufficient_data',
        threshold: gate.threshold,
        observed: values,
      };
    }

    const observed = values.slice(-gate.consecutive_windows);
    const breached = observed.every((value) => value > gate.threshold);
    return {
      name: gate.name,
      action: gate.action,
      status: breached ? 'breached' : 'ok',
      threshold: gate.threshold,
      observed,
    };
  });

  return { decision: decide(gates), gates };
}

function decide(gates: GateResult[]): Decision {
  if (gates.some((g) => g.status === 'breached' && g.action === 'rollback')) return 'rollback';
  if (gates.some((g) => g.status !== 'ok')) return 'pause';
  return 'proceed';
}

/**
 * Decides whether a paused rollout may continue. Each gate with a recovery rule
 * needs its last `recovery.windows` values at or below `recovery.threshold`.
 * Gates without a recovery rule must be healthy in the current window. A gate
 * with too few windows is treated as still recovering.
 */
export function evaluateResume(policy: Policy, snapshot: Snapshot): Evaluation {
  const current = evaluate(policy, snapshot);
  const gates = current.gates.map((result): GateResult => {
    const gate = policy.gates.find((g) => g.name === result.name);
    if (!gate || result.status !== 'ok' || !gate.recovery) return result;

    const values = snapshot[gate.name] ?? [];
    const recent = values.slice(-gate.recovery.windows);
    const recovered =
      recent.length === gate.recovery.windows && recent.every((v) => v <= gate.recovery!.threshold);
    return recovered ? result : { ...result, status: 'recovering', observed: recent };
  });

  return { decision: decide(gates), gates };
}

export function evaluateMode(policy: Policy, snapshot: Snapshot, mode: Mode): Evaluation {
  return mode === 'resume' ? evaluateResume(policy, snapshot) : evaluate(policy, snapshot);
}

function parseArgs(argv: string[]): { metrics: string; policy: string; mode: Mode } {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const metrics = value('--metrics');
  if (!metrics) fail('--metrics <snapshot.json> is required');

  const mode = value('--mode') ?? 'evaluate';
  if (mode !== 'evaluate' && mode !== 'resume') fail('--mode must be "evaluate" or "resume"');

  const defaultPolicy = resolve(import.meta.dir, '../docs/releases/health-gates.json');
  return { metrics, policy: value('--policy') ?? defaultPolicy, mode };
}

function main(): number {
  const { metrics, policy: policyPath, mode } = parseArgs(process.argv.slice(2));

  const policyText = readFileSync(policyPath, 'utf-8');
  const policy = parsePolicy(JSON.parse(policyText));
  const snapshot = parseSnapshot(JSON.parse(readFileSync(metrics, 'utf-8')));
  const result = evaluateMode(policy, snapshot, mode);

  const report = {
    mode,
    decision: result.decision,
    policy_version: policy.policy_version,
    policy_sha256: createHash('sha256').update(policyText).digest('hex'),
    evaluated_at: new Date().toISOString(),
    gates: result.gates,
  };
  console.log(JSON.stringify(report, null, 2));
  return EXIT_CODES[result.decision];
}

if (import.meta.main) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(`release-health-gate: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(ERROR_EXIT_CODE);
  }
}
