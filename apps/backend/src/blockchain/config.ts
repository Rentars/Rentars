import { StrKey } from '@stellar/stellar-sdk';
import {
  getHorizonUrl,
  getNetworkPassphrase,
  getStellarNetwork,
  validateEnvNetworkPassphrase,
} from './network.js';
import { validateAgainstRegistry } from './registry.js';

export const STELLAR_RPC_URL =
  process.env.STELLAR_RPC_URL ??
  (getStellarNetwork() === 'mainnet'
    ? 'https://soroban-mainnet.stellar.org'
    : 'https://soroban-testnet.stellar.org');

export const NETWORK_PASSPHRASE =
  process.env.STELLAR_NETWORK_PASSPHRASE?.trim() || getNetworkPassphrase();

export { getStellarNetwork, getNetworkPassphrase, getHorizonUrl };

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

  const passphraseMismatch = validateEnvNetworkPassphrase();
  if (passphraseMismatch) {
    errors.push({
      field: 'STELLAR_NETWORK_PASSPHRASE',
      message: passphraseMismatch,
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

  if (BLOCKCHAIN_FEATURES_ENABLED && errors.length === 0) {
    errors.push(
      ...validateAgainstRegistry({
        blockchainFeaturesEnabled: BLOCKCHAIN_FEATURES_ENABLED,
        networkPassphrase: NETWORK_PASSPHRASE,
        stellarNetwork: getStellarNetwork(),
        contractIds: {
          'property-listing': PROPERTY_LISTING_CONTRACT_ID,
          booking: BOOKING_CONTRACT_ID,
          review: REVIEW_CONTRACT_ID,
        },
      }),
    );
  }

  return errors;
}
