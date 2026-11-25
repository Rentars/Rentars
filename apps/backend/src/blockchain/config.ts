import { Networks, StrKey } from '@stellar/stellar-sdk';

export type StellarNetworkName = 'testnet' | 'mainnet' | 'futurenet';

export interface StellarNetworkConfig {
  name: StellarNetworkName;
  passphrase: string;
  rpcUrl: string;
  contracts: {
    propertyListing: string;
    booking: string;
    review: string;
  };
}

const SUPPORTED_NETWORKS: Record<StellarNetworkName, string> = {
  testnet: Networks.TESTNET,
  mainnet: Networks.PUBLIC,
  futurenet: Networks.FUTURENET,
};

export const STELLAR_RPC_URL =
  process.env.STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org';

export const NETWORK_PASSPHRASE =
  process.env.STELLAR_NETWORK_PASSPHRASE ?? Networks.TESTNET;

export const PROPERTY_LISTING_CONTRACT_ID =
  process.env.PROPERTY_LISTING_CONTRACT_ID ?? '';

export const BOOKING_CONTRACT_ID = process.env.BOOKING_CONTRACT_ID ?? '';

export const REVIEW_CONTRACT_ID = process.env.REVIEW_CONTRACT_ID ?? '';

export const STELLAR_SOURCE_ACCOUNT =
  process.env.STELLAR_SOURCE_ACCOUNT ??
  'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';

export const STELLAR_ADMIN_SECRET = process.env.STELLAR_ADMIN_SECRET ?? '';

export const BASE_FEE = process.env.STELLAR_BASE_FEE ?? '100';

export const BLOCKCHAIN_FEATURES_ENABLED =
  process.env.BLOCKCHAIN_FEATURES_ENABLED === 'true';

/**
 * Path or URL to the signed deployment manifest describing the deployed
 * contract IDs, network, source commit and artifact hashes for this release.
 */
export const DEPLOYMENT_MANIFEST_PATH =
  process.env.DEPLOYMENT_MANIFEST_PATH ?? '';

/**
 * Network the deployment manifest is expected to describe (e.g. "testnet").
 * When set, the manifest must match this network.
 */
export const DEPLOYMENT_MANIFEST_NETWORK =
  process.env.DEPLOYMENT_MANIFEST_NETWORK ?? '';

/**
 * When true, backend startup verifies that the configured contract IDs match
 * the deployment manifest (if one is available) and fails on mismatch.
 */
export const VERIFY_DEPLOYMENT_MANIFEST_ON_STARTUP =
  process.env.VERIFY_DEPLOYMENT_MANIFEST_ON_STARTUP === 'true';

/**
 * Resolve the configured network name from the passphrase. Returns null when
 * the passphrase does not match any supported network.
 */
export function resolveNetworkName(
  passphrase: string = NETWORK_PASSPHRASE,
): StellarNetworkName | null {
  const entry = (Object.entries(SUPPORTED_NETWORKS) as [
    StellarNetworkName,
    string,
  ][]).find(([, value]) => value === passphrase);
  return entry ? entry[0] : null;
}

/**
 * Single source of truth for the active Stellar network configuration.
 * Throws when the configured passphrase is not a supported network so that
 * callers fail fast instead of signing on an unexpected network.
 */
export function getNetworkConfig(): StellarNetworkConfig {
  const name = resolveNetworkName(NETWORK_PASSPHRASE);
  if (!name) {
    throw new Error(
      `Unsupported Stellar network passphrase: ${NETWORK_PASSPHRASE}`,
    );
  }
  return {
    name,
    passphrase: NETWORK_PASSPHRASE,
    rpcUrl: STELLAR_RPC_URL,
    contracts: {
      propertyListing: PROPERTY_LISTING_CONTRACT_ID,
      booking: BOOKING_CONTRACT_ID,
      review: REVIEW_CONTRACT_ID,
    },
  };
}

/**
 * Compare a wallet-provided network (name or passphrase) against the backend
 * network. Returns a structured result rather than throwing so callers can
 * surface safe guidance to the user.
 */
export function compareWalletNetwork(walletNetwork: string): {
  matches: boolean;
  backendNetwork: StellarNetworkName | null;
  walletNetwork: string;
  message?: string;
} {
  const backendNetwork = resolveNetworkName();
  const normalized = walletNetwork.trim();
  const walletName =
    resolveNetworkName(normalized) ??
    (normalized.toLowerCase() as StellarNetworkName);
  const matches = backendNetwork !== null && walletName === backendNetwork;
  return {
    matches,
    backendNetwork,
    walletNetwork: normalized,
    message: matches
      ? undefined
      : `Wallet network "${normalized}" does not match backend network "${backendNetwork ?? 'unknown'}". Switch your wallet network before signing.`,
  };
}

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

function isManifestLocationValid(location: string): boolean {
  if (!location) return false;
  if (location.startsWith('http://') || location.startsWith('https://')) {
    return isValidUrl(location);
  }
  // Treat anything else as a filesystem path.
  return location.trim().length > 0;
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
  } else if (!resolveNetworkName(NETWORK_PASSPHRASE)) {
    errors.push({
      field: 'STELLAR_NETWORK_PASSPHRASE',
      message: `Unsupported network passphrase: ${NETWORK_PASSPHRASE}`,
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
  }

  if (VERIFY_DEPLOYMENT_MANIFEST_ON_STARTUP) {
    if (!DEPLOYMENT_MANIFEST_PATH) {
      errors.push({
        field: 'DEPLOYMENT_MANIFEST_PATH',
        message:
          'DEPLOYMENT_MANIFEST_PATH is required when VERIFY_DEPLOYMENT_MANIFEST_ON_STARTUP is enabled',
      });
    } else if (!isManifestLocationValid(DEPLOYMENT_MANIFEST_PATH)) {
      errors.push({
        field: 'DEPLOYMENT_MANIFEST_PATH',
        message: `Invalid deployment manifest location: ${DEPLOYMENT_MANIFEST_PATH}`,
      });
    }

    if (!DEPLOYMENT_MANIFEST_NETWORK) {
      errors.push({
        field: 'DEPLOYMENT_MANIFEST_NETWORK',
        message:
          'DEPLOYMENT_MANIFEST_NETWORK is required when VERIFY_DEPLOYMENT_MANIFEST_ON_STARTUP is enabled',
      });
    }
  }

  return errors;
}

/**
 * Fail fast at startup when the blockchain configuration is invalid.
 */
export function assertBlockchainConfig(): void {
  const errors = validateBlockchainConfig();
  if (errors.length > 0) {
    throw new Error(
      `Invalid blockchain configuration: ${errors
        .map((e) => `${e.field}: ${e.message}`)
        .join('; ')}`,
    );
  }
}
