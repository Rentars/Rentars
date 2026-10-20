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
 *
 * Contract upgrade evidence (#781): when --compat <file> is supplied, the gate
 * also requires a migration changelog entry and an ABI diff check for the
 * release, and fails closed when the old and new contract versions are not
 * declared compatible. See docs/releases/contract-upgrades.md.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type GateAction = 'pause' | 'rollback';
export type Decision = 'proceed' | 'pause' | 'rollback';
export type Mode = 'evaluate' | 'resume';
export type CompatStatus = 'ok' | 'missing_evidence' | 'incompatible';

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

export interface ContractVersion {
  contract: string;
  version: string;
}

export interface CompatibilityEvidence {
  /** Old and new contract versions must both be declared. */
  from: ContractVersion;
  to: ContractVersion;
  /** Path to the migration changelog entry for this release. */
  migration_changelog: string;
  /** Path to the recorded ABI diff check output. */
  abi_diff: string;
  /** Whether the ABI diff check passed. */
  abi_diff_passed: boolean;
  /** Whether the application was verified against the new ABI. */
  application_compatible: boolean;
}

export interface CompatibilityResult {
  status: CompatStatus;
  from: ContractVersion | null;
  to: ContractVersion | null;
  reasons: string[];
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

function parseContractVersion(raw: unknown, field: string): ContractVersion {
  if (
    !isRecord(raw) ||
    typeof raw.contract !== 'string' ||
    raw.contract === '' ||
    typeof raw.version !== 'string' ||
    raw.version === ''
  ) {
    fail(`${field} must declare a non-empty contract and version`);
  }
  return { contract: raw.contract, version: raw.version };
}

export function parseCompatibility(raw: unknown): CompatibilityEvidence {
  if (!isRecord(raw)) fail('compatibility evidence must be a JSON object');

  const from = parseContractVersion(raw.from, 'from');
  const to = parseContractVersion(raw.to, 'to');

  if (typeof raw.migration_changelog !== 'string' || raw.migration_changelog === '') {
    fail('migration_changelog must be a non-empty path');
  }
  if (typeof raw.abi_diff !== 'string' || raw.abi_diff === '') {
    fail('abi_diff must be a non-empty path');
  }
  if (typeof raw.abi_diff_passed !== 'boolean') fail('abi_diff_passed must be a boolean');
  if (typeof raw.application_compatible !== 'boolean') {
    fail('application_compatible must be a boolean');
  }

  return {
    from,
    to,
    migration_changelog: raw.migration_changelog,
    abi_diff: raw.abi_diff,
    abi_diff_passed: raw.abi_diff_passed,
    application_compatible: raw.application_compatible,
  };
}

/**
 * Verifies the contract upgrade evidence. The gate fails closed: missing
 * evidence, a failed ABI diff, an application that was not verified against the
 * new ABI, or undeclared/identical versions all block the release.
 */
export function evaluateCompatibility(evidence: CompatibilityEvidence): CompatibilityResult {
  const reasons: string[] = [];

  if (evidence.from.contract !== evidence.to.contract) {
    reasons.push(
      `contract identity changed (${evidence.from.contract} -> ${evidence.to.contract}); ` +
        'successor deployments must be recorded as a migration, not an in-place upgrade',
    );
  }
  if (evidence.from.version === evidence.to.version) {
    reasons.push(
      `contract version not bumped (${evidence.from.version}); declare the new version explicitly`,
    );
  }
  if (!evidence.abi_diff_passed) reasons.push('ABI diff check did not pass');
  if (!evidence.application_compatible) {
    reasons.push('application compatibility against the new ABI was not verified');
  }

  const status: CompatStatus =
    reasons.length === 0
      ? 'ok'
      : reasons.some((r) => r.includes('not bumped') || r.includes('identity changed'))
        ? 'incompatible'
        : 'missing_evidence';

  return { status, from: evidence.from, to: evidence.to, reasons };
}

function readEvidenceFile(path: string, label: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    fail(`${label} not found at ${path}`);
  }
}

/**
 * Loads the compatibility evidence and confirms the referenced migration
 * changelog and ABI diff artifacts exist and are non-empty.
 */
export function loadCompatibility(path: string): CompatibilityEvidence {
  const evidence = parseCompatibility(JSON.parse(readFileSync(path, 'utf-8')));
  const base = resolve(path, '..');

  const changelog = readEvidenceFile(resolve(base, evidence.migration_changelog), 'migration changelog');
  if (changelog.trim() === '') fail('migration changelog is empty');
  const abiDiff = readEvidenceFile(resolve(base, evidence.abi_diff), 'ABI diff check');
  if (abiDiff.trim() === '') fail('ABI diff check output is empty');

  return evidence;
}

function parseArgs(argv: string[]): {
  metrics: string;
  policy: string;
  mode: Mode;
  compat: string | null;
} {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const metrics = value('--metrics');
  if (!metrics) fail('--metrics <snapshot.json> is required');

  const mode = value('--mode') ?? 'evaluate';
  if (mode !== 'evaluate' && mode !== 'resume') fail('--mode must be "evaluate" or "resume"');

  const defaultPolicy = resolve(import.meta.dir, '../docs/releases/health-gates.json');
  return {
    metrics,
    policy: value('--policy') ?? defaultPolicy,
    mode,
    compat: value('--compat') ?? null,
  };
}

function main(): number {
  const { metrics, policy: policyPath, mode, compat } = parseArgs(process.argv.slice(2));

  const policyText = readFileSync(policyPath, 'utf-8');
  const policy = parsePolicy(JSON.parse(policyText));
  const snapshot = parseSnapshot(JSON.parse(readFileSync(metrics, 'utf-8')));
  const result = evaluateMode(policy, snapshot, mode);

  const compatibility = compat ? evaluateCompatibility(loadCompatibility(compat)) : null;
  const decision: Decision =
    compatibility && compatibility.status !== 'ok' ? 'pause' : result.decision;

  const report = {
    mode,
    decision,
    policy_version: policy.policy_version,
    policy_sha256: createHash('sha256').update(policyText).digest('hex'),
    evaluated_at: new Date().toISOString(),
    gates: result.gates,
    compatibility,
  };
  console.log(JSON.stringify(report, null, 2));
  return EXIT_CODES[decision];
}

if (import.meta.main) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(`release-health-gate: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(ERROR_EXIT_CODE);
  }
}
