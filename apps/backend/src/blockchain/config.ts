import { Networks, StrKey } from '@stellar/stellar-sdk';

export const STELLAR_RPC_URL =
  process.env.STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org';

export const NETWORK_PASSPHRASE =
  process.env.STELLAR_NETWORK_PASSPHRASE ?? Networks.TESTNET;

export const PROPERTY_LISTING_CONTRACT_ID =
  process.env.PROPERTY_LISTING_CONTRACT_ID ?? '';

export const BOOKING_CONTRACT_ID = process.env.BOOKING_CONTRACT_ID ?? '';

export const REVIEW_CONTRACT_ID = process.env.REVIEW_CONTRACT_ID ?? '';

/**
 * Contract versioning / upgrade strategy.
 *
 * Soroban contract upgrades may require deploying a successor contract and
 * repointing integrations rather than rolling back in place. To keep old and
 * new contract versions identifiable and to allow a dual-read compatibility
 * period, each contract family exposes:
 *
 *  - `<NAME>_CONTRACT_VERSION`: the version label of the active contract
 *    (e.g. "v1", "v2"). Defaults to "v1".
 *  - `<NAME>_CONTRACT_ID_LEGACY`: the previous contract ID, kept readable
 *    during the compatibility window. Empty when there is no predecessor.
 *  - `<NAME>_CONTRACT_ID_SUCCESSOR`: the successor contract ID that will
 *    become active at cutover. Empty when no upgrade is staged.
 *  - `<NAME>_CONTRACT_ACTIVE_VERSION`: selects which version is authoritative
 *    for writes ("legacy" | "current" | "successor"). Defaults to "current".
 *
 * The primary `<NAME>_CONTRACT_ID` always identifies the currently active
 * contract. During a staged upgrade the successor is deployed and validated
 * on testnet while `ACTIVE_VERSION` remains "current"; at cutover the primary
 * ID is repointed to the successor and `ACTIVE_VERSION` flips to "successor".
 */
export type ContractVersionSelector = 'legacy' | 'current' | 'successor';

export interface ContractVersionConfig {
  /** Version label of the active contract, e.g. "v1". */
  version: string;
  /** Active contract ID (the primary `<NAME>_CONTRACT_ID`). */
  contractId: string;
  /** Previous contract ID, readable during the compatibility period. */
  legacyContractId: string;
  /** Staged successor contract ID, if an upgrade is in progress. */
  successorContractId: string;
  /** Which version is authoritative for writes. */
  activeVersion: ContractVersionSelector;
}

function parseVersionSelector(
  raw: string | undefined,
  field: string,
): ContractVersionSelector {
  const value = (raw ?? 'current').trim().toLowerCase();
  if (value === 'legacy' || value === 'current' || value === 'successor') {
    return value;
  }
  throw new Error(
    `Invalid ${field}: "${raw}". Expected one of: legacy, current, successor`,
  );
}

function readContractVersionConfig(
  prefix: string,
  contractId: string,
): ContractVersionConfig {
  return {
    version: process.env[`${prefix}_CONTRACT_VERSION`] ?? 'v1',
    contractId,
    legacyContractId: process.env[`${prefix}_CONTRACT_ID_LEGACY`] ?? '',
    successorContractId: process.env[`${prefix}_CONTRACT_ID_SUCCESSOR`] ?? '',
    activeVersion: parseVersionSelector(
      process.env[`${prefix}_CONTRACT_ACTIVE_VERSION`],
      `${prefix}_CONTRACT_ACTIVE_VERSION`,
    ),
  };
}

export const PROPERTY_LISTING_CONTRACT_VERSIONS: ContractVersionConfig =
  readContractVersionConfig('PROPERTY_LISTING', PROPERTY_LISTING_CONTRACT_ID);

export const BOOKING_CONTRACT_VERSIONS: ContractVersionConfig =
  readContractVersionConfig('BOOKING', BOOKING_CONTRACT_ID);

export const REVIEW_CONTRACT_VERSIONS: ContractVersionConfig =
  readContractVersionConfig('REVIEW', REVIEW_CONTRACT_ID);

export const CONTRACT_VERSION_CONFIGS: Record<string, ContractVersionConfig> = {
  propertyListing: PROPERTY_LISTING_CONTRACT_VERSIONS,
  booking: BOOKING_CONTRACT_VERSIONS,
  review: REVIEW_CONTRACT_VERSIONS,
};

/**
 * Returns the contract IDs a client should read from for a given contract
 * family. During the compatibility period this includes the legacy ID so
 * callers can dual-read and reconcile records across versions.
 */
export function getReadableContractIds(
  config: ContractVersionConfig,
): string[] {
  const ids = [config.contractId];
  if (config.legacyContractId && config.legacyContractId !== config.contractId) {
    ids.push(config.legacyContractId);
  }
  if (
    config.successorContractId &&
    config.successorContractId !== config.contractId
  ) {
    ids.push(config.successorContractId);
  }
  return ids.filter((id) => id.length > 0);
}

/**
 * Returns the contract ID that should be used for writes given the active
 * version selector. Falls back to the primary contract ID when the selected
 * version has no ID configured.
 */
export function getWriteContractId(config: ContractVersionConfig): string {
  switch (config.activeVersion) {
    case 'legacy':
      return config.legacyContractId || config.contractId;
    case 'successor':
      return config.successorContractId || config.contractId;
    case 'current':
    default:
      return config.contractId;
  }
}

export const STELLAR_SOURCE_ACCOUNT =
  process.env.STELLAR_SOURCE_ACCOUNT ??
  'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';

export const STELLAR_ADMIN_SECRET = process.env.STELLAR_ADMIN_SECRET ?? '';

export const BASE_FEE = process.env.STELLAR_BASE_FEE ?? '100';

export const BLOCKCHAIN_FEATURES_ENABLED =
  process.env.BLOCKCHAIN_FEATURES_ENABLED === 'true';

interface ConfigValidationError {
  field: string;
  message: string;
}

function isValidContractId(id: string): boolean {
  if (!id) return false;
  try {
    return StrKey.isValidContract(id);
  } catch {
    return false;
  }
}

function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

export function validateBlockchainConfig(): ConfigValidationError[] {
  const errors: ConfigValidationError[] = [];

  if (!isValidUrl(STELLAR_RPC_URL)) {
    errors.push({
      field: 'STELLAR_RPC_URL',
      message: `Invalid RPC URL: ${STELLAR_RPC_URL}`,
    });
  }

  if (!NETWORK_PASSPHRASE) {
    errors.push({
      field: 'STELLAR_NETWORK_PASSPHRASE',
      message: 'Network passphrase is required',
    });
  }

  if (BLOCKCHAIN_FEATURES_ENABLED) {
    if (!isValidContractId(PROPERTY_LISTING_CONTRACT_ID)) {
      errors.push({
        field: 'PROPERTY_LISTING_CONTRACT_ID',
        message: `Invalid or missing contract ID: ${PROPERTY_LISTING_CONTRACT_ID}`,
      });
    }

    if (!isValidContractId(BOOKING_CONTRACT_ID)) {
      errors.push({
        field: 'BOOKING_CONTRACT_ID',
        message: `Invalid or missing contract ID: ${BOOKING_CONTRACT_ID}`,
      });
    }

    if (!isValidContractId(REVIEW_CONTRACT_ID)) {
      errors.push({
        field: 'REVIEW_CONTRACT_ID',
        message: `Invalid or missing contract ID: ${REVIEW_CONTRACT_ID}`,
      });
    }

    if (!STELLAR_ADMIN_SECRET) {
      errors.push({
        field: 'STELLAR_ADMIN_SECRET',
        message: 'Admin secret key is required when blockchain features are enabled',
      });
    }

    for (const [name, config] of Object.entries(CONTRACT_VERSION_CONFIGS)) {
      const prefix = name.toUpperCase();

      if (config.legacyContractId && !isValidContractId(config.legacyContractId)) {
        errors.push({
          field: `${prefix}_CONTRACT_ID_LEGACY`,
          message: `Invalid legacy contract ID: ${config.legacyContractId}`,
        });
      }

      if (
        config.successorContractId &&
        !isValidContractId(config.successorContractId)
      ) {
        errors.push({
          field: `${prefix}_CONTRACT_ID_SUCCESSOR`,
          message: `Invalid successor contract ID: ${config.successorContractId}`,
        });
      }

      if (config.activeVersion === 'legacy' && !config.legacyContractId) {
        errors.push({
          field: `${prefix}_CONTRACT_ACTIVE_VERSION`,
          message: 'Active version is "legacy" but no legacy contract ID is configured',
        });
      }

      if (config.activeVersion === 'successor' && !config.successorContractId) {
        errors.push({
          field: `${prefix}_CONTRACT_ACTIVE_VERSION`,
          message:
            'Active version is "successor" but no successor contract ID is configured',
        });
      }
    }
  }

  return errors;
}
