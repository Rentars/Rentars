import { Networks, StrKey } from '@stellar/stellar-sdk';

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
