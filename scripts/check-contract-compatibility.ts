#!/usr/bin/env bun
/**
 * Deployment-time contract compatibility check.
 *
 * Resolves issue #120 (compatibility-check requirement): before releasing,
 * verify that the built contract WASM artifacts match the ABI versions and
 * WASM hashes the backend expects.
 *
 * Sources of truth:
 *   - apps/backend/src/blockchain/contractRegistry.ts
 *       exports CONTRACT_REGISTRY (per-contract ABI version + expected WASM hash)
 *       and COMPATIBLE_APPS (app version -> required contract ABI versions).
 *   - A built WASM manifest (JSON) describing the artifacts produced by the
 *       contract build, e.g.:
 *         {
 *           "contracts": {
 *             "escrow": { "abiVersion": 2, "wasmHash": "abc123...", "wasmPath": "target/..." }
 *           }
 *         }
 *
 * Runs fully offline with no production credentials. Exits non-zero with a
 * clear message on any incompatibility.
 *
 * Usage:
 *   bun scripts/check-contract-compatibility.ts [--manifest <path>] [--app-version <version>]
 *
 * Defaults:
 *   --manifest      target/contract-manifest.json (or $CONTRACT_MANIFEST)
 *   --app-version   apps/backend/package.json "version" (or $APP_VERSION)
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

const REGISTRY_PATH = join(
  REPO_ROOT,
  "apps/backend/src/blockchain/contractRegistry.ts",
);
const BACKEND_PACKAGE_PATH = join(REPO_ROOT, "apps/backend/package.json");
const DEFAULT_MANIFEST_PATH = join(REPO_ROOT, "target/contract-manifest.json");

interface ContractRegistryEntry {
  /** ABI version the backend client is compiled against. */
  abiVersion: number;
  /** Expected SHA-256 hash of the deployed/built WASM, if pinned. */
  wasmHash?: string;
  /** Whether the contract is expected to be upgradeable. Informational. */
  upgradeable?: boolean;
}

interface ContractManifestEntry {
  abiVersion: number;
  wasmHash: string;
  wasmPath?: string;
}

interface ContractManifest {
  contracts: Record<string, ContractManifestEntry>;
}

interface CompatibilityProblem {
  contract: string;
  message: string;
}

function log(message: string): void {
  console.log(`[contract-compat] ${message}`);
}

function fail(message: string): never {
  console.error(`[contract-compat] ERROR: ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]): {
  manifestPath: string;
  appVersion?: string;
} {
  let manifestPath =
    process.env.CONTRACT_MANIFEST ?? DEFAULT_MANIFEST_PATH;
  let appVersion = process.env.APP_VERSION;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--manifest") {
      const value = argv[++i];
      if (!value) fail("--manifest requires a path argument");
      manifestPath = value;
    } else if (arg.startsWith("--manifest=")) {
      manifestPath = arg.slice("--manifest=".length);
    } else if (arg === "--app-version") {
      const value = argv[++i];
      if (!value) fail("--app-version requires a version argument");
      appVersion = value;
    } else if (arg.startsWith("--app-version=")) {
      appVersion = arg.slice("--app-version=".length);
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: bun scripts/check-contract-compatibility.ts [--manifest <path>] [--app-version <version>]",
      );
      process.exit(0);
    } else {
      fail(`Unknown argument: ${arg}`);
    }
  }

  return {
    manifestPath: isAbsolute(manifestPath)
      ? manifestPath
      : resolve(REPO_ROOT, manifestPath),
    appVersion,
  };
}

/**
 * Load the backend contract registry module. The registry is a TypeScript
 * module with no network or credential dependencies, so importing it directly
 * is safe and keeps this check in sync with the backend's assumptions.
 */
async function loadRegistry(): Promise<{
  contractRegistry: Record<string, ContractRegistryEntry>;
  compatibleApps: Record<string, Record<string, number>>;
}> {
  if (!existsSync(REGISTRY_PATH)) {
    fail(
      `Backend contract registry not found at ${REGISTRY_PATH}. ` +
        `Cannot verify contract compatibility.`,
    );
  }

  let mod: Record<string, unknown>;
  try {
    mod = (await import(REGISTRY_PATH)) as Record<string, unknown>;
  } catch (err) {
    fail(
      `Failed to import backend contract registry (${REGISTRY_PATH}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const contractRegistry = (mod.CONTRACT_REGISTRY ??
    mod.contractRegistry) as Record<string, ContractRegistryEntry> | undefined;
  const compatibleApps = (mod.COMPATIBLE_APPS ??
    mod.compatibleApps) as Record<string, Record<string, number>> | undefined;

  if (!contractRegistry || typeof contractRegistry !== "object") {
    fail(
      `Backend contract registry (${REGISTRY_PATH}) does not export ` +
        `CONTRACT_REGISTRY. Cannot verify contract compatibility.`,
    );
  }

  return {
    contractRegistry,
    compatibleApps: compatibleApps ?? {},
  };
}

function loadManifest(manifestPath: string): ContractManifest {
  if (!existsSync(manifestPath)) {
    fail(
      `Contract WASM manifest not found at ${manifestPath}. ` +
        `Build the contracts first or pass --manifest <path>.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    fail(
      `Failed to parse contract manifest (${manifestPath}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const manifest = parsed as Partial<ContractManifest>;
  if (!manifest || typeof manifest !== "object" || !manifest.contracts) {
    fail(
      `Contract manifest (${manifestPath}) is malformed: expected an object ` +
        `with a "contracts" map.`,
    );
  }

  return manifest as ContractManifest;
}

function resolveAppVersion(explicit?: string): string | undefined {
  if (explicit) return explicit;
  if (!existsSync(BACKEND_PACKAGE_PATH)) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(BACKEND_PACKAGE_PATH, "utf8")) as {
      version?: string;
    };
    return pkg.version;
  } catch {
    return undefined;
  }
}

function normalizeHash(hash: string): string {
  return hash.trim().toLowerCase().replace(/^0x/, "");
}

function checkCompatibility(
  registry: Record<string, ContractRegistryEntry>,
  compatibleApps: Record<string, Record<string, number>>,
  manifest: ContractManifest,
  appVersion: string | undefined,
): CompatibilityProblem[] {
  const problems: CompatibilityProblem[] = [];
  const manifestContracts = manifest.contracts ?? {};

  // 1. Every contract the backend expects must be present in the build.
  for (const [name, expected] of Object.entries(registry)) {
    const built = manifestContracts[name];
    if (!built) {
      problems.push({
        contract: name,
        message:
          `Contract "${name}" is required by the backend registry but is ` +
          `missing from the WASM manifest.`,
      });
      continue;
    }

    // 2. ABI version must match exactly.
    if (built.abiVersion !== expected.abiVersion) {
      problems.push({
        contract: name,
        message:
          `ABI version mismatch for "${name}": backend expects ` +
          `v${expected.abiVersion}, built artifact is v${built.abiVersion}.`,
      });
    }

    // 3. Pinned WASM hash must match, when the registry pins one.
    if (expected.wasmHash) {
      if (!built.wasmHash) {
        problems.push({
          contract: name,
          message:
            `WASM hash missing for "${name}" in the manifest, but the ` +
            `backend registry pins hash ${expected.wasmHash}.`,
        });
      } else if (
        normalizeHash(built.wasmHash) !== normalizeHash(expected.wasmHash)
      ) {
        problems.push({
          contract: name,
          message:
            `WASM hash mismatch for "${name}": backend expects ` +
            `${normalizeHash(expected.wasmHash)}, built artifact is ` +
            `${normalizeHash(built.wasmHash)}.`,
        });
      }
    }
  }

  // 4. Contracts built but not known to the backend are suspicious.
  for (const name of Object.keys(manifestContracts)) {
    if (!(name in registry)) {
      problems.push({
        contract: name,
        message:
          `Contract "${name}" is present in the WASM manifest but unknown to ` +
          `the backend registry. Update the registry or remove the artifact.`,
      });
    }
  }

  // 5. If the app version is known, verify the COMPATIBLE_APPS matrix agrees
  //    with the registry's ABI expectations for that release.
  if (appVersion && Object.keys(compatibleApps).length > 0) {
    const required = compatibleApps[appVersion];
    if (!required) {
      problems.push({
        contract: "*",
        message:
          `App version "${appVersion}" has no entry in COMPATIBLE_APPS. ` +
          `Add the release to the compatibility matrix before deploying.`,
      });
    } else {
      for (const [name, requiredAbi] of Object.entries(required)) {
        const expected = registry[name];
        if (!expected) {
          problems.push({
            contract: name,
            message:
              `COMPATIBLE_APPS["${appVersion}"] references contract ` +
              `"${name}" that is not in CONTRACT_REGISTRY.`,
          });
          continue;
        }
        if (expected.abiVersion !== requiredAbi) {
          problems.push({
            contract: name,
            message:
              `COMPATIBLE_APPS["${appVersion}"] requires "${name}" ABI ` +
              `v${requiredAbi}, but CONTRACT_REGISTRY expects ` +
              `v${expected.abiVersion}.`,
          });
        }
      }
    }
  }

  return problems;
}

async function main(): Promise<void> {
  const { manifestPath, appVersion: explicitAppVersion } = parseArgs(
    process.argv.slice(2),
  );

  log(`Registry: ${REGISTRY_PATH}`);
  log(`Manifest: ${manifestPath}`);

  const { contractRegistry, compatibleApps } = await loadRegistry();
  const manifest = loadManifest(manifestPath);
  const appVersion = resolveAppVersion(explicitAppVersion);

  if (appVersion) {
    log(`App version: ${appVersion}`);
  } else {
    log(
      "App version: unknown (skipping COMPATIBLE_APPS matrix check; " +
        "pass --app-version to enable it)",
    );
  }

  const problems = checkCompatibility(
    contractRegistry,
    compatibleApps,
    manifest,
    appVersion,
  );

  if (problems.length > 0) {
    console.error(
      `\n[contract-compat] FAILED: ${problems.length} compatibility ` +
        `problem(s) detected. Deployment must not proceed.\n`,
    );
    for (const problem of problems) {
      console.error(`  - [${problem.contract}] ${problem.message}`);
    }
    console.error(
      `\nSee docs/contract-upgrade-policy.md for the upgrade and migration ` +
        `policy. Rebuild the contracts or update the backend registry so ` +
        `their ABI versions and WASM hashes agree.\n`,
    );
    process.exit(1);
  }

  const count = Object.keys(manifest.contracts ?? {}).length;
  log(
    `OK: ${count} contract(s) match the backend registry ` +
      `(ABI versions and WASM hashes verified).`,
  );
}

main().catch((err) => {
  fail(
    `Unexpected error during compatibility check: ${
      err instanceof Error ? err.stack ?? err.message : String(err)
    }`,
  );
});