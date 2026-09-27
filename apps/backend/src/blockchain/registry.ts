import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Networks } from '@stellar/stellar-sdk';

export type ContractKey = 'property-listing' | 'booking' | 'review';

export type RegistryNetwork = 'testnet' | 'mainnet';

export interface RegistryContractEntry {
  contractKey: ContractKey;
  network: RegistryNetwork;
  contractId: string;
  wasmHash: string;
  abiVersion: string;
  abiFile: string;
  abiSha256: string;
  initDependencies: ContractKey[];
  compatibleAppVersions: string[];
  allowedUpgradeContractIds: string[];
  releaseNotes: string;
}

export interface ContractRegistry {
  schemaVersion: string;
  updatedAt: string;
  contracts: RegistryContractEntry[];
}

export interface RegistryValidationError {
  field: string;
  message: string;
}

export interface PublicContractVersion {
  contractKey: ContractKey;
  network: RegistryNetwork;
  abiVersion: string;
  wasmHashPrefix: string;
  abiSha256Prefix: string;
  initDependencies: ContractKey[];
  releaseNotes: string;
}

const CONTRACT_ENV_FIELDS: Record<ContractKey, string> = {
  'property-listing': 'PROPERTY_LISTING_CONTRACT_ID',
  booking: 'BOOKING_CONTRACT_ID',
  review: 'REVIEW_CONTRACT_ID',
};

const moduleDir = dirname(fileURLToPath(import.meta.url));

const DEFAULT_REGISTRY_PATH = resolve(
  moduleDir,
  '../../../contracts/registry/contract-registry.json',
);

const ABI_DIR = resolve(moduleDir, '../../../contracts');

function resolveRegistryPath(): string {
  const explicit = process.env.CONTRACT_REGISTRY_PATH?.trim();
  if (explicit) return explicit;

  const candidates = [
    DEFAULT_REGISTRY_PATH,
    resolve(process.cwd(), 'apps/contracts/registry/contract-registry.json'),
    resolve(process.cwd(), '../contracts/registry/contract-registry.json'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return DEFAULT_REGISTRY_PATH;
}

function resolveAbiDir(): string {
  const candidates = [
    ABI_DIR,
    resolve(process.cwd(), 'apps/contracts'),
    resolve(process.cwd(), '../contracts'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return ABI_DIR;
}

function resolveAppVersion(): string {
  if (process.env.APP_VERSION?.trim()) {
    return process.env.APP_VERSION.trim();
  }
  try {
    const pkgPath = resolve(moduleDir, '../../package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function resolveRegistryNetwork(
  stellarNetwork: string | undefined,
  networkPassphrase: string,
): RegistryNetwork {
  if (stellarNetwork === 'mainnet') return 'mainnet';
  if (stellarNetwork === 'testnet') return 'testnet';
  if (networkPassphrase === Networks.PUBLIC) return 'mainnet';
  return 'testnet';
}

export function loadRegistry(registryPath = resolveRegistryPath()): ContractRegistry {
  if (!existsSync(registryPath)) {
    throw new Error(`Contract registry not found at ${registryPath}`);
  }
  const raw = JSON.parse(readFileSync(registryPath, 'utf-8')) as ContractRegistry;
  if (!raw.contracts || !Array.isArray(raw.contracts)) {
    throw new Error('Contract registry is missing a contracts array');
  }
  return raw;
}

function truncateHash(hash: string, visible = 8): string {
  if (hash.length <= visible * 2 + 3) return hash;
  return `${hash.slice(0, visible)}…${hash.slice(-visible)}`;
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function isAllowedContractId(entry: RegistryContractEntry, configuredId: string): boolean {
  if (configuredId === entry.contractId) return true;
  return entry.allowedUpgradeContractIds.includes(configuredId);
}

export interface ValidateAgainstRegistryInput {
  blockchainFeaturesEnabled: boolean;
  networkPassphrase: string;
  stellarNetwork?: string;
  appVersion?: string;
  contractIds: Record<ContractKey, string>;
  registry?: ContractRegistry;
}

export function validateAgainstRegistry(
  input: ValidateAgainstRegistryInput,
): RegistryValidationError[] {
  if (!input.blockchainFeaturesEnabled) {
    return [];
  }

  const errors: RegistryValidationError[] = [];
  const network = resolveRegistryNetwork(input.stellarNetwork, input.networkPassphrase);
  const appVersion = input.appVersion ?? resolveAppVersion();

  let registry: ContractRegistry;
  try {
    registry = input.registry ?? loadRegistry();
  } catch (err) {
    errors.push({
      field: 'CONTRACT_REGISTRY',
      message: err instanceof Error ? err.message : 'Failed to load contract registry',
    });
    return errors;
  }

  const networkEntries = registry.contracts.filter((e) => e.network === network);
  if (networkEntries.length === 0) {
    errors.push({
      field: 'CONTRACT_REGISTRY',
      message: `No registry entries for network "${network}"`,
    });
    return errors;
  }

  for (const contractKey of Object.keys(CONTRACT_ENV_FIELDS) as ContractKey[]) {
    const envField = CONTRACT_ENV_FIELDS[contractKey];
    const configuredId = input.contractIds[contractKey];
    const entry = networkEntries.find((e) => e.contractKey === contractKey);

    if (!entry) {
      errors.push({
        field: envField,
        message: `No registry entry for ${contractKey} on ${network}`,
      });
      continue;
    }

    if (!isAllowedContractId(entry, configuredId)) {
      errors.push({
        field: envField,
        message:
          `Contract ID ${configuredId} is not registered for ${contractKey} on ${network}. ` +
          `Expected ${entry.contractId}` +
          (entry.allowedUpgradeContractIds.length
            ? ` or an allowed upgrade ID: ${entry.allowedUpgradeContractIds.join(', ')}`
            : ''),
      });
    }

    if (!entry.compatibleAppVersions.includes(appVersion)) {
      errors.push({
        field: 'APP_VERSION',
        message:
          `App version ${appVersion} is not compatible with ${contractKey} on ${network}. ` +
          `Supported: ${entry.compatibleAppVersions.join(', ')}`,
      });
    }

    const abiPath = resolve(resolveAbiDir(), entry.abiFile);
    if (!existsSync(abiPath)) {
      errors.push({
        field: 'CONTRACT_REGISTRY',
        message: `ABI file missing for ${contractKey}: ${entry.abiFile}`,
      });
      continue;
    }

    const onDiskAbiHash = sha256File(abiPath);
    if (onDiskAbiHash !== entry.abiSha256) {
      errors.push({
        field: 'CONTRACT_REGISTRY',
        message:
          `ABI hash mismatch for ${contractKey}: registry has ${entry.abiSha256}, ` +
          `on-disk ${entry.abiFile} is ${onDiskAbiHash}. Run release:manifest to refresh registry.`,
      });
    }

    for (const dep of entry.initDependencies) {
      const depEntry = networkEntries.find((e) => e.contractKey === dep);
      if (!depEntry) {
        errors.push({
          field: 'CONTRACT_REGISTRY',
          message: `${contractKey} init dependency "${dep}" is not registered on ${network}`,
        });
      }
    }
  }

  return errors;
}

export function getPublicContractVersions(options?: {
  networkPassphrase?: string;
  stellarNetwork?: string;
  registry?: ContractRegistry;
}): PublicContractVersion[] {
  const networkPassphrase =
    options?.networkPassphrase ??
    process.env.STELLAR_NETWORK_PASSPHRASE ??
    Networks.TESTNET;
  const network = resolveRegistryNetwork(options?.stellarNetwork ?? process.env.STELLAR_NETWORK, networkPassphrase);

  let registry: ContractRegistry;
  try {
    registry = options?.registry ?? loadRegistry();
  } catch {
    return [];
  }

  return registry.contracts
    .filter((e) => e.network === network)
    .map((entry) => ({
      contractKey: entry.contractKey,
      network: entry.network,
      abiVersion: entry.abiVersion,
      wasmHashPrefix: truncateHash(entry.wasmHash),
      abiSha256Prefix: truncateHash(entry.abiSha256),
      initDependencies: entry.initDependencies,
      releaseNotes: entry.releaseNotes,
    }));
}
