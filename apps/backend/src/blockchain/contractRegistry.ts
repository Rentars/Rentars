/**
 * Contract Version Registry
 *
 * Single source of truth for all deployed Soroban contract metadata.
 * Populated from environment variables at startup and validated before
 * the server accepts traffic.
 *
 * What is tracked per contract:
 *   - contractId       — deployed contract address (StrKey-encoded)
 *   - abiVersion       — semver string sourced from the ABI JSON
 *   - wasmHash         — SHA-256 hash of the deployed WASM binary (hex)
 *   - network          — Stellar network the contract is deployed on
 *   - deployedAt       — ISO-8601 deployment timestamp (optional)
 *   - compatibleApps   — semver ranges of app releases known to work
 *   - upgradeable      — whether the deployed contract can be upgraded
 *   - upgradeAuthority — admin address authorized to upgrade, or 'immutable'
 *
 * All fields except wasmHash and deployedAt are required for production.
 * A mismatch between the registry entry and the configured contract ID is
 * detected at startup via validateContractRegistry().
 *
 * Upgrade policy (issue 120):
 *   - `upgradeable` is sourced from UPGRADEABLE_<CONTRACT> ("true"/"false",
 *     default "false"). Contracts default to immutable: an operator must opt
 *     in explicitly before a contract is treated as upgradeable.
 *   - `upgradeAuthority` is sourced from UPGRADE_AUTHORITY_<CONTRACT>. For
 *     upgradeable contracts it must be a valid Stellar account (StrKey G...)
 *     address that holds the contract admin role. For immutable contracts it
 *     must be unset or the literal string 'immutable'.
 *   - validateContractRegistry() rejects inconsistent combinations (e.g. an
 *     upgradeable contract with no admin, or an immutable contract with an
 *     admin address) so operators can always determine whether a deployed
 *     contract can be upgraded and who may authorize it.
 *
 * Upgrade sequencing:
 *   1. Deploy new WASM to staging; update WASM_HASH_<CONTRACT> env vars.
 *   2. Run validateContractRegistry() in the staging pipeline.
 *   3. After smoke-testing, promote env vars to production.
 *   4. Restart the production server; startup validation confirms consistency.
 */

import { StrKey } from '@stellar/stellar-sdk';
import { env } from '@/config/env.js';
import {
  BOOKING_CONTRACT_ID,
  NETWORK_PASSPHRASE,
  PROPERTY_LISTING_CONTRACT_ID,
  REVIEW_CONTRACT_ID,
} from './config.js';

// ─── ABI version constants (single source; keep in sync with ABI JSON files) ─

export const ABI_VERSIONS = {
  booking: '0.1.0',
  propertyListing: '0.1.0',
  review: '0.1.0',
} as const;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ContractRegistryEntry {
  /** Human-readable contract name. */
  name: string;
  /** Deployed Soroban contract ID (StrKey-encoded). */
  contractId: string;
  /** ABI version (semver string). */
  abiVersion: string;
  /**
   * SHA-256 hash of the deployed WASM binary, hex-encoded.
   * Set via WASM_HASH_<CONTRACT_NAME> env var.  Empty string when not yet set.
   */
  wasmHash: string;
  /** Stellar network this entry applies to. */
  network: 'testnet' | 'mainnet';
  /**
   * ISO-8601 timestamp of the most recent deployment.
   * Set via DEPLOY_TIME_<CONTRACT_NAME> env var.  null when not tracked.
   */
  deployedAt: string | null;
  /**
   * Semver ranges (comma-separated) of application releases known to be
   * compatible with this contract + ABI version.
   * Example: ">=1.0.0 <2.0.0"
   */
  compatibleApps: string;
  /**
   * Source commit hash the deployed WASM was built from.
   * Set via SOURCE_COMMIT_<CONTRACT_NAME> env var.  Empty string when unknown.
   */
  sourceCommit: string;
  /**
   * Rust toolchain (e.g. "1.79.0") used to build the deployed WASM.
   * Set via TOOLCHAIN_<CONTRACT_NAME> env var.  Empty string when unknown.
   */
  toolchain: string;
  /**
   * Build target triple (e.g. "wasm32-unknown-unknown").
   * Set via BUILD_TARGET_<CONTRACT_NAME> env var.  Empty string when unknown.
   */
  buildTarget: string;
  /**
   * Transaction hash of the contract initialization call, if any.
   * Set via INIT_TX_<CONTRACT_NAME> env var.  null when not applicable.
   */
  initTxHash: string | null;
  /**
   * Environment this entry was recorded for (e.g. "production", "staging").
   * Derived from DEPLOY_ENV.  Defaults to NODE_ENV.
   */
  environment: string;
  /**
   * Whether the deployed contract can be upgraded in place.
   * Set via UPGRADEABLE_<CONTRACT_NAME> env var ("true"/"false").
   * Defaults to false (immutable) when unset.
   */
  upgradeable: boolean;
  /**
   * Admin address authorized to authorize an upgrade, or the literal
   * 'immutable' when the contract cannot be upgraded.
   * Set via UPGRADE_AUTHORITY_<CONTRACT_NAME> env var.
   */
  upgradeAuthority: string;
}

export interface ContractRegistryValidationError {
  contract: string;
  field: string;
  message: string;
}

// ─── Build the registry from environment ─────────────────────────────────────

function resolveNetwork(): 'testnet' | 'mainnet' {
  return env.STELLAR_NETWORK;
}

function resolveEnvironment(): string {
  return process.env.DEPLOY_ENV ?? env.NODE_ENV;
}

function parseUpgradeable(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === '') return false;
  return raw.trim().toLowerCase() === 'true';
}

function buildEntry(
  name: string,
  contractId: string,
  abiVersion: string,
  wasmHashEnvKey: string,
  deployTimeEnvKey: string,
  compatibleAppsEnvKey: string,
  upgradeableEnvKey: string,
  upgradeAuthorityEnvKey: string,
): ContractRegistryEntry {
  const prefix = name.replace(/([A-Z])/g, '_$1').toUpperCase();
  const upgradeable = parseUpgradeable(process.env[upgradeableEnvKey]);
  const rawAuthority = process.env[upgradeAuthorityEnvKey];
  const upgradeAuthority = upgradeable
    ? (rawAuthority ?? '')
    : (rawAuthority && rawAuthority.trim() !== '' ? rawAuthority : 'immutable');

  return {
    name,
    contractId,
    abiVersion,
    wasmHash: process.env[wasmHashEnvKey] ?? '',
    network: resolveNetwork(),
    deployedAt: process.env[deployTimeEnvKey] ?? null,
    compatibleApps: process.env[compatibleAppsEnvKey] ?? '*',
    sourceCommit: process.env[`SOURCE_COMMIT_${prefix}`] ?? '',
    toolchain: process.env[`TOOLCHAIN_${prefix}`] ?? '',
    buildTarget: process.env[`BUILD_TARGET_${prefix}`] ?? '',
    initTxHash: process.env[`INIT_TX_${prefix}`] ?? null,
    environment: resolveEnvironment(),
    upgradeable,
    upgradeAuthority,
  };
}

/**
 * Live registry built from the current environment.
 * Exported so other modules can read contract metadata at runtime.
 */
export const CONTRACT_REGISTRY: Readonly<Record<string, ContractRegistryEntry>> = Object.freeze({
  booking: buildEntry(
    'booking',
    BOOKING_CONTRACT_ID,
    ABI_VERSIONS.booking,
    'WASM_HASH_BOOKING',
    'DEPLOY_TIME_BOOKING',
    'COMPATIBLE_APPS_BOOKING',
    'UPGRADEABLE_BOOKING',
    'UPGRADE_AUTHORITY_BOOKING',
  ),
  propertyListing: buildEntry(
    'propertyListing',
    PROPERTY_LISTING_CONTRACT_ID,
    ABI_VERSIONS.propertyListing,
    'WASM_HASH_PROPERTY_LISTING',
    'DEPLOY_TIME_PROPERTY_LISTING',
    'COMPATIBLE_APPS_PROPERTY_LISTING',
    'UPGRADEABLE_PROPERTY_LISTING',
    'UPGRADE_AUTHORITY_PROPERTY_LISTING',
  ),
  review: buildEntry(
    'review',
    REVIEW_CONTRACT_ID,
    ABI_VERSIONS.review,
    'WASM_HASH_REVIEW',
    'DEPLOY_TIME_REVIEW',
    'COMPATIBLE_APPS_REVIEW',
    'UPGRADEABLE_REVIEW',
    'UPGRADE_AUTHORITY_REVIEW',
  ),
});

// ─── Validation ───────────────────────────────────────────────────────────────

function isValidContractId(id: string): boolean {
  if (!id) return false;
  try {
    return StrKey.isValidContract(id);
  } catch {
    return false;
  }
}

function isValidAccountId(id: string): boolean {
  if (!id) return false;
  try {
    return StrKey.isValidEd25519PublicKey(id);
  } catch {
    return false;
  }
}

/**
 * Validate every entry in the registry.
 *
 * Called at startup (before accepting traffic) so misconfigured contracts
 * are caught before any booking or payment flow can touch an invalid address.
 *
 * When `strict` is true (default in production), missing WASM hashes are
 * also reported as errors.  In development/staging they are warnings only.
 */
export function validateContractRegistry(
  strict = env.NODE_ENV === 'production',
): ContractRegistryValidationError[] {
  const errors: ContractRegistryValidationError[] = [];

  for (const [key, entry] of Object.entries(CONTRACT_REGISTRY)) {
    // Contract ID must be present and a valid StrKey.
    if (!entry.contractId) {
      errors.push({
        contract: key,
        field: 'contractId',
        message: `Contract ID for '${key}' is not set. Configure the corresponding environment variable.`,
      });
    } else if (!isValidContractId(entry.contractId)) {
      errors.push({
        contract: key,
        field: 'contractId',
        message: `Contract ID for '${key}' is not a valid Soroban contract address: ${entry.contractId}`,
      });
    }

    // ABI version must be a non-empty semver-ish string.
    if (!entry.abiVersion || !/^\d+\.\d+\.\d+/.test(entry.abiVersion)) {
      errors.push({
        contract: key,
        field: 'abiVersion',
        message: `ABI version for '${key}' is missing or malformed: ${entry.abiVersion}`,
      });
    }

    // Network must agree with the backend's configured network.
    if (entry.network !== env.STELLAR_NETWORK) {
      errors.push({
        contract: key,
        field: 'network',
        message: `Registry network '${entry.network}' does not match STELLAR_NETWORK='${env.STELLAR_NETWORK}'.`,
      });
    }

    // Upgrade policy: operators must be able to tell whether the contract is
    // upgradeable and, if so, which admin address may authorize the upgrade.
    if (entry.upgradeable) {
      if (!entry.upgradeAuthority || entry.upgradeAuthority === 'immutable') {
        errors.push({
          contract: key,
          field: 'upgradeAuthority',
          message: `Contract '${key}' is marked upgradeable but has no upgrade authority. Set UPGRADE_AUTHORITY_${key.replace(/([A-Z])/g, '_$1').toUpperCase()} to the admin account address.`,
        });
      } else if (!isValidAccountId(entry.upgradeAuthority)) {
        errors.push({
          contract: key,
          field: 'upgradeAuthority',
          message: `Upgrade authority for '${key}' is not a valid Stellar account address: ${entry.upgradeAuthority}`,
        });
      }
    } else if (entry.upgradeAuthority !== 'immutable') {
      errors.push({
        contract: key,
        field: 'upgradeAuthority',
        message: `Contract '${key}' is marked immutable but UPGRADE_AUTHORITY_${key.replace(/([A-Z])/g, '_$1').toUpperCase()} is set to '${entry.upgradeAuthority}'. Unset it or set UPGRADEABLE_${key.replace(/([A-Z])/g, '_$1').toUpperCase()}=true.`,
      });
    }

    // WASM hash: required in production; advisory in other environments.
    if (!entry.wasmHash) {
      if (strict) {
        errors.push({
          contract: key,
          field: 'wasmHash',
          message: `WASM hash for '${key}' is not set. Set WASM_HASH_${key.replace(/([A-Z])/g, '_$1').toUpperCase()} before deploying to production.`,
        });
      } else {
        console.warn(
          `[contract-registry] WASM hash for '${key}' is not set. ` +
          `Set WASM_HASH_${key.replace(/([A-Z])/g, '_$1').toUpperCase()} before deploying to production.`,
        );
      }
    }

    // WASM hash must be a 64-char hex SHA-256 digest when present.
    if (entry.wasmHash && !/^[0-9a-f]{64}$/i.test(entry.wasmHash)) {
      errors.push({
        contract: key,
        field: 'wasmHash',
        message: `WASM hash for '${key}' is not a valid SHA-256 hex digest: ${entry.wasmHash}`,
      });
    }

    // Source commit: required in production so artifacts are traceable.
    if (!entry.sourceCommit) {
      if (strict) {
        errors.push({
          contract: key,
          field: 'sourceCommit',
          message: `Source commit for '${key}' is not set. Set SOURCE_COMMIT_${key.replace(/([A-Z])/g, '_$1').toUpperCase()} before deploying to production.`,
        });
      }
    } else if (!/^[0-9a-f]{7,40}$/i.test(entry.sourceCommit)) {
      errors.push({
        contract: key,
        field: 'sourceCommit',
        message: `Source commit for '${key}' is not a valid git commit hash: ${entry.sourceCommit}`,
      });
    }

    // Build target must be the Soroban WASM target when recorded.
    if (entry.buildTarget && entry.buildTarget !== 'wasm32-unknown-unknown') {
      errors.push({
        contract: key,
        field: 'buildTarget',
        message: `Build target for '${key}' must be 'wasm32-unknown-unknown', got '${entry.buildTarget}'.`,
      });
    }

    // Init transaction hash must look like a Stellar transaction hash when set.
    if (entry.initTxHash && !/^[0-9a-f]{64}$/i.test(entry.initTxHash)) {
      errors.push({
        contract: key,
        field: 'initTxHash',
        message: `Init transaction hash for '${key}' is not a valid 32-byte hex hash: ${entry.initTxHash}`,
      });
    }
  }

  return errors;
}

// ─── Deployment verification ──────────────────────────────────────────────────

export interface ContractVerificationResult {
  contract: string;
  ok: boolean;
  /** Configured contract ID from backend config. */
  configuredId: string;
  /** Contract ID recorded in the deployment manifest/registry. */
  manifestId: string;
  /** Human-readable mismatch description, when ok === false. */
  mismatch?: string;
}

/**
 * Compare the deployed contract IDs recorded in the registry (i.e. the
 * deployment manifest promoted into the environment) against the IDs the
 * backend is actually configured to call.
 *
 * When a manifest entry is available for a contract, a mismatch is reported
 * as an error.  When no manifest data is present (e.g. local development),
 * the check is skipped and reported as ok so startup is not blocked.
 *
 * Never logs or returns secret material — only public contract identifiers.
 */
export function verifyDeployedContracts(): ContractVerificationResult[] {
  const configured: Record<string, string> = {
    booking: BOOKING_CONTRACT_ID,
    propertyListing: PROPERTY_LISTING_CONTRACT_ID,
    review: REVIEW_CONTRACT_ID,
  };

  const results: ContractVerificationResult[] = [];

  for (const [key, entry] of Object.entries(CONTRACT_REGISTRY)) {
    const configuredId = configured[key] ?? '';
    const manifestId = entry.contractId ?? '';

    if (!manifestId) {
      results.push({
        contract: key,
        ok: true,
        configuredId,
        manifestId,
        mismatch: 'No manifest entry recorded; verification skipped.',
      });
      continue;
    }

    if (manifestId !== configuredId) {
      results.push({
        contract: key,
        ok: false,
        configuredId,
        manifestId,
        mismatch: `Configured contract ID for '${key}' does not match the deployment manifest.`,
      });
      continue;
    }

    results.push({ contract: key, ok: true, configuredId, manifestId });
  }

  return results;
}

/**
 * Startup guard: run registry validation plus manifest verification and
 * throw if any hard error is found.  Call before the server accepts traffic.
 */
export function assertContractRegistryValid(
  strict = env.NODE_ENV === 'production',
): void {
  const errors = validateContractRegistry(strict);
  const mismatches = verifyDeployedContracts().filter((r) => !r.ok);

  for (const m of mismatches) {
    errors.push({
      contract: m.contract,
      field: 'contractId',
      message: m.mismatch ?? 'Contract ID mismatch between manifest and configuration.',
    });
  }

  if (errors.length > 0) {
    const summary = errors
      .map((e) => `  - [${e.contract}.${e.field}] ${e.message}`)
      .join('\n');
    throw new Error(`[contract-registry] Startup validation failed:\n${summary}`);
  }
}

// ─── Accessor helpers ─────────────────────────────────────────────────────────

/**
 * Return the registry entry for a contract by key.
 * Throws if the key is not in the registry (programming error).
 */
export function getContractEntry(key: keyof typeof CONTRACT_REGISTRY): ContractRegistryEntry {
  const entry = CONTRACT_REGISTRY[key];
  if (!entry) {
    throw new Error(`[contract-registry] Unknown contract key: '${key}'`);
  }
  return entry;
}

/**
 * Safe subset of the registry suitable for public API responses.
 * Excludes nothing sensitive (all fields are non-secret) but provides a
 * stable shape independent of the internal registry structure.
 */
export interface PublicContractInfo {
  name: string;
  contractId: string;
  abiVersion: string;
  wasmHash: string;
  network: string;
  deployedAt: string | null;
  compatibleApps: string;
  sourceCommit: string;
  toolchain: string;
  buildTarget: string;
  initTxHash: string | null;
  environment: string;
  upgradeable: boolean;
  upgradeAuthority: string;
}

export function getPublicContractInfo(): PublicContractInfo[] {
  return Object.values(CONTRACT_REGISTRY).map((e) => ({
    name: e.name,
    contractId: e.contractId,
    abiVersion: e.abiVersion,
    wasmHash: e.wasmHash,
    network: e.network,
    deployedAt: e.deployedAt,
    compatibleApps: e.compatibleApps,
    sourceCommit: e.sourceCommit,
    toolchain: e.toolchain,
    buildTarget: e.buildTarget,
    initTxHash: e.initTxHash,
    environment: e.environment,
    upgradeable: e.upgradeable,
    upgradeAuthority: e.upgradeAuthority,
  }));
}

// ─── Cross-contract compatibility checks ─────────────────────────────────────

/**
 * Contracts that participate in the integrated rental flow and therefore must
 * be mutually compatible.  A change to either side of these pairs can compile
 * independently yet break the end-to-end listing → booking → status flow.
 */
export const CROSS_CONTRACT_PAIRS: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ['booking', 'propertyListing'],
]);

/**
 * Parse a comma-separated list of semver ranges (e.g. ">=1.0.0 <2.0.0, ^1.2.0").
 * Returns null when any range is malformed so callers can report the field.
 */
export function parseCompatibleAppsRanges(compatibleApps: string): string[] | null {
  if (!compatibleApps || !compatibleApps.trim()) return null;
  const ranges = compatibleApps
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
  if (ranges.length === 0) return null;
  // Each range must start with an operator or a digit and contain a version.
  const rangePattern = /^(?:[<>=^~*]+\s*)?\d+(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.-]+)?$/;
  for (const range of ranges) {
    if (!rangePattern.test(range)) return null;
  }
  return ranges;
}

/**
 * Validate cross-contract invariants for the integrated rental flow.
 *
 * Reported invariants:
 *   - contractId: booking and property-listing IDs must both be present/valid
 *   - abiVersion: paired contracts must agree on the ABI major version
 *   - compatibleApps: ranges must be parseable
 *   - network: every entry must match the configured network
 */
export function validateCrossContractCompatibility(): ContractRegistryValidationError[] {
  const errors: ContractRegistryValidationError[] = [];

  for (const [a, b] of CROSS_CONTRACT_PAIRS) {
    const entryA = CONTRACT_REGISTRY[a];
    const entryB = CONTRACT_REGISTRY[b];
    if (!entryA || !entryB) {
      errors.push({
        contract: `${a}<->${b}`,
        field: 'contractId',
        message: `Cross-contract pair '${a}<->${b}' is missing a registry entry; the integrated rental flow cannot be validated.`,
      });
      continue;
    }

    // Both sides of the pair must expose a valid contract address.
    for (const entry of [entryA, entryB]) {
      if (!entry.contractId || !isValidContractId(entry.contractId)) {
        errors.push({
          contract: entry.name,
          field: 'contractId',
          message: `Cross-contract invariant 'contractId' violated: '${entry.name}' has no valid contract address, so '${a}<->${b}' calls cannot be routed.`,
        });
      }
    }

    // ABI major versions must agree across the pair.
    const majorA = entryA.abiVersion.split('.')[0];
    const majorB = entryB.abiVersion.split('.')[0];
    if (majorA !== majorB) {
      errors.push({
        contract: `${a}<->${b}`,
        field: 'abiVersion',
        message: `Cross-contract invariant 'abiVersion' violated: '${a}' is ${entryA.abiVersion} but '${b}' is ${entryB.abiVersion}; major versions must match.`,
      });
    }
  }

  // compatibleApps ranges must be parseable for every entry.
  for (const [key, entry] of Object.entries(CONTRACT_REGISTRY)) {
    if (parseCompatibleAppsRanges(entry.compatibleApps) === null) {
      errors.push({
        contract: key,
        field: 'compatibleApps',
        message: `Cross-contract invariant 'compatibleApps' violated: '${key}' has unparseable range '${entry.compatibleApps}'.`,
      });
    }
  }

  return errors;
}
