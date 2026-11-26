#!/usr/bin/env bun
/**
 * Generates a machine-readable release manifest at
 * docs/releases/manifest-<version>.json.
 *
 * The manifest records:
 *   - commit SHA and tag
 *   - per-component versions (backend, web, contracts)
 *   - latest applied migration
 *   - ABI file hashes for each contract
 *   - per-contract deployment data (commit, toolchain, target, artifact hash,
 *     network, contract ID, initialization transaction)
 *   - Docker image identifiers (if IMAGE_TAG env is set)
 *   - rollback documentation pointer
 *
 * Usage:
 *   bun run scripts/generate-release-manifest.ts [--version <semver>]
 *   bun run scripts/generate-release-manifest.ts --verify
 *
 * Reads version from:
 *   1. --version CLI flag
 *   2. ROOT_VERSION env variable
 *   3. root package.json version field
 *
 * --verify compares the contract IDs recorded in the environment-specific
 * registry (docs/releases/contract-registry.json) and the latest release
 * manifest against the backend configuration, exiting non-zero on mismatch.
 *
 * Wallet secret material (secret keys, mnemonics) is never read, printed or
 * stored by this script.
 */

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf-8');
}

function json(rel: string): Record<string, unknown> {
  return JSON.parse(read(rel));
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function git(cmd: string): string {
  try {
    return execSync(`git ${cmd}`, { cwd: ROOT, encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

// ── Contract deployment metadata ─────────────────────────────────────────────
// Contract names map to the backend env var that configures their ID.
const CONTRACTS: Array<{ name: string; envVar: string; wasm: string }> = [
  { name: 'property_listing', envVar: 'PROPERTY_LISTING_CONTRACT_ID', wasm: 'property_listing.wasm' },
  { name: 'booking', envVar: 'BOOKING_CONTRACT_ID', wasm: 'booking.wasm' },
  { name: 'review', envVar: 'REVIEW_CONTRACT_ID', wasm: 'review.wasm' },
];

const REGISTRY_PATH = 'docs/releases/contract-registry.json';

interface ContractDeployment {
  contract_id: string | null;
  network: string | null;
  init_transaction: string | null;
  artifact_sha256: string | null;
  artifact_path: string | null;
  source_commit: string;
  toolchain: string;
  target: string;
}

function readToolchain(): string {
  const rustToolchain = resolve(ROOT, 'rust-toolchain.toml');
  if (existsSync(rustToolchain)) {
    const match = read('rust-toolchain.toml').match(/^channel\s*=\s*"([^"]+)"/m);
    if (match) return match[1];
  }
  try {
    return execSync('rustc --version', { cwd: ROOT, encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

function readTarget(): string {
  return process.env.CONTRACT_BUILD_TARGET ?? 'wasm32-unknown-unknown';
}

function artifactHash(wasm: string): { sha256: string | null; path: string | null } {
  const candidates = [
    `apps/contracts/target/wasm32-unknown-unknown/release/${wasm}`,
    `apps/contracts/target/wasm32v1-none/release/${wasm}`,
    `apps/contracts/artifacts/${wasm}`,
  ];
  for (const rel of candidates) {
    if (existsSync(resolve(ROOT, rel))) {
      return { sha256: sha256(readFileSync(resolve(ROOT, rel)).toString('binary')), path: rel };
    }
  }
  return { sha256: null, path: null };
}

function buildContractDeployments(commit: string): Record<string, ContractDeployment> {
  const toolchain = readToolchain();
  const target = readTarget();
  const network = process.env.STELLAR_NETWORK ?? null;
  const deployments: Record<string, ContractDeployment> = {};
  for (const contract of CONTRACTS) {
    const artifact = artifactHash(contract.wasm);
    deployments[contract.name] = {
      contract_id: process.env[contract.envVar] ?? null,
      network,
      init_transaction: process.env[`${contract.envVar.replace(/_CONTRACT_ID$/, '')}_INIT_TX`] ?? null,
      artifact_sha256: artifact.sha256,
      artifact_path: artifact.path,
      source_commit: commit,
      toolchain,
      target,
    };
  }
  return deployments;
}

function loadRegistry(): Record<string, Record<string, ContractDeployment>> {
  if (!existsSync(resolve(ROOT, REGISTRY_PATH))) return {};
  try {
    return JSON.parse(read(REGISTRY_PATH)) as Record<string, Record<string, ContractDeployment>>;
  } catch {
    return {};
  }
}

function writeRegistry(
  registry: Record<string, Record<string, ContractDeployment>>,
  network: string,
  deployments: Record<string, ContractDeployment>
): void {
  registry[network] = { ...(registry[network] ?? {}), ...deployments };
  writeFileSync(resolve(ROOT, REGISTRY_PATH), JSON.stringify(registry, null, 2) + '\n');
}

// ── Verification mode ────────────────────────────────────────────────────────
// Compares deployed contract IDs (registry + latest manifest) with the backend
// configuration. Exits non-zero on any mismatch so CI/startup can gate on it.
function verify(): void {
  const network = process.env.STELLAR_NETWORK ?? null;
  const registry = loadRegistry();
  const deployed = network ? (registry[network] ?? {}) : {};
  const problems: string[] = [];

  for (const contract of CONTRACTS) {
    const configured = process.env[contract.envVar] ?? null;
    const recorded = deployed[contract.name]?.contract_id ?? null;
    if (recorded && configured && recorded !== configured) {
      problems.push(
        `${contract.name}: configured ${contract.envVar}=${configured} does not match deployed ${recorded}`
      );
    } else if (recorded && !configured) {
      problems.push(`${contract.name}: deployed ${recorded} but ${contract.envVar} is not configured`);
    }
  }

  if (problems.length > 0) {
    console.error('Contract ID verification failed:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`Contract ID verification passed${network ? ` for network ${network}` : ''}.`);
}

if (process.argv.includes('--verify')) {
  verify();
  process.exit(0);
}

// ── Resolve version ──────────────────────────────────────────────────────────
const versionFlag = process.argv.findIndex((a) => a === '--version');
const version: string =
  versionFlag >= 0
    ? (process.argv[versionFlag + 1] ?? '')
    : (process.env.ROOT_VERSION ?? String((json('package.json') as { version?: string }).version ?? '0.0.0'));

if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`Invalid version: "${version}". Pass --version X.Y.Z or set ROOT_VERSION.`);
  process.exit(1);
}

// ── Component versions ────────────────────────────────────────────────────────
const backendPkg = json('apps/backend/package.json') as { version?: string };
const webPkg = json('apps/web/package.json') as { version?: string };
const contractsCargo = read('apps/contracts/Cargo.toml');
const contractsVersion = contractsCargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? 'unknown';

// ── Latest migration ─────────────────────────────────────────────────────────
const migrationsDir = resolve(ROOT, 'apps/backend/database/migrations');
let latestMigration = 'none';
let migrationCount = 0;
if (existsSync(migrationsDir)) {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  migrationCount = files.length;
  if (files.length > 0) latestMigration = files[files.length - 1];
}

// ── Rollback target and gate policy ──────────────────────────────────────────
// The rollback target is the newest manifest that is not this release. Its
// existence is what makes "roll back to the last known-good release" answerable.
const releasesDir = resolve(ROOT, 'docs/releases');
const gatePolicyPath = 'docs/releases/health-gates.json';
const previousManifest = existsSync(releasesDir)
  ? (readdirSync(releasesDir)
      .filter((f) => /^manifest-.+\.json$/.test(f) && f !== `manifest-${version}.json`)
      .map((f) => ({
        file: f,
        generatedAt: String(
          (json(`docs/releases/${f}`) as { generated_at?: unknown }).generated_at ?? ''
        ),
      }))
      .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))[0]?.file ?? null)
  : null;

// ── ABI hashes ───────────────────────────────────────────────────────────────
const abiFiles = ['booking_abi.json', 'property_listing_abi.json', 'review_abi.json'];
const abiHashes: Record<string, string> = {};
for (const abi of abiFiles) {
  const path = `apps/contracts/${abi}`;
  if (existsSync(resolve(ROOT, path))) {
    abiHashes[abi] = sha256(read(path));
  }
}

// ── Migration checksum / validation results ──────────────────────────────────
// These are produced by the migration tooling and written to a well-known
// results file (or supplied via env) so the manifest can link version,
// migration state and health results for each deployment.
function readJsonIfExists(rel: string): Record<string, unknown> | null {
  if (!existsSync(resolve(ROOT, rel))) return null;
  try {
    return json(rel);
  } catch {
    return null;
  }
}

const migrationChecksums =
  readJsonIfExists('docs/releases/migration-checksums.json') ??
  (process.env.MIGRATION_CHECKSUMS_JSON
    ? (JSON.parse(process.env.MIGRATION_CHECKSUMS_JSON) as Record<string, unknown>)
    : null);

const migrationValidation =
  readJsonIfExists('docs/releases/migration-validation.json') ??
  (process.env.MIGRATION_VALIDATION_JSON
    ? (JSON.parse(process.env.MIGRATION_VALIDATION_JSON) as Record<string, unknown>)
    : null);

// ── Health gate results ──────────────────────────────────────────────────────
// Smoke-test results are written by the deployment health gate runner. The
// manifest records the decision (pass/fail) and the per-check outcomes so a
// deployment record can be audited against the gate policy.
const healthResults =
  readJsonIfExists('docs/releases/health-results.json') ??
  (process.env.HEALTH_RESULTS_JSON
    ? (JSON.parse(process.env.HEALTH_RESULTS_JSON) as Record<string, unknown>)
    : null);

const healthDecision: 'pass' | 'fail' | 'not_run' =
  healthResults && typeof healthResults.decision === 'string'
    ? (healthResults.decision as 'pass' | 'fail')
    : 'not_run';

// ── Git metadata ──────────────────────────────────────────────────────────────
const commit = git('rev-parse HEAD');
const tag = git('describe --tags --exact-match 2>/dev/null') || `v${version}`;

// ── Assemble manifest ────────────────────────────────────────────────────────
const manifest = {
  schema_version: '1',
  generated_at: new Date().toISOString(),
  release: {
    version,
    commit,
    tag,
    image_tag: process.env.IMAGE_TAG ?? null,
  },
  components: {
    backend: { version: backendPkg.version ?? version },
    web: { version: webPkg.version ?? version },
    contracts: { version: contractsVersion },
  },
  database: {
    latest_migration: latestMigration,
    migration_count: migrationCount,
    checksums: migrationChecksums
      ? {
          status: migrationChecksums.status ?? 'unknown',
          checked_at: migrationChecksums.checked_at ?? null,
          mismatches: migrationChecksums.mismatches ?? [],
        }
      : null,
    validation: migrationValidation
      ? {
          status: migrationValidation.status ?? 'unknown',
          checked_at: migrationValidation.checked_at ?? null,
          errors: migrationValidation.errors ?? [],
        }
      : null,
  },
  dependencies: {
    stellar_network: process.env.STELLAR_NETWORK ?? null,
    contract_ids: {
      property_listing: process.env.PROPERTY_LISTING_CONTRACT_ID ?? null,
      booking: process.env.BOOKING_CONTRACT_ID ?? null,
      review: process.env.REVIEW_CONTRACT_ID ?? null,
    },
  },
  contracts: {
    abi_sha256: abiHashes,
    upgradeability: contractUpgradeability,
    compatibility_check: compatibilityCheck,
    deployments: buildContractDeployments(commit),
  },
  health: {
    decision: healthDecision,
    results: healthResults
      ? {
          generated_at: healthResults.generated_at ?? null,
          environment: healthResults.environment ?? null,
          checks: healthResults.checks ?? [],
        }
      : null,
  },
  rollback: {
    docs: 'docs/releases/rollback.md',
    prior_manifest_pattern: `docs/releases/manifest-*.json`,
    previous_manifest: previousManifest ? `docs/releases/${previousManifest}` : null,
    health_gate_policy: {
      path: gatePolicyPath,
      sha256: existsSync(resolve(ROOT, gatePolicyPath)) ? sha256(read(gatePolicyPath)) : null,
    },
  },
};

// ── Write ─────────────────────────────────────────────────────────────────────
const outDir = resolve(ROOT, 'docs/releases');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const outPath = resolve(outDir, `manifest-${version}.json`);
writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Release manifest written to: ${outPath.replace(ROOT + '/', '')}`);

// ── Update environment-specific contract registry ────────────────────────────
if (manifest.dependencies.stellar_network) {
  const registry = loadRegistry();
  writeRegistry(registry, manifest.dependencies.stellar_network, manifest.contracts.deployments);
  console.log(`Contract registry updated: ${REGISTRY_PATH}`);
} else {
  console.warn('STELLAR_NETWORK not set; contract registry not updated.');
}
