/**
 * Central Stellar network configuration and validation (#619).
 *
 * All backend Horizon / XDR paths must use this module — never default to
 * testnet in production when STELLAR_NETWORK is unset.
 */

import {
  FeeBumpTransaction,
  Keypair,
  Networks,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

type ParsedStellarTx = Transaction | FeeBumpTransaction;

export type StellarNetwork = 'testnet' | 'mainnet';

const MAINNET_PASSPHRASE = Networks.PUBLIC;
const TESTNET_PASSPHRASE = Networks.TESTNET;

export class NetworkMismatchError extends Error {
  readonly code = 'NETWORK_MISMATCH' as const;
  readonly expectedNetwork: StellarNetwork;
  readonly actualNetwork: StellarNetwork | 'unknown';

  constructor(
    message: string,
    expectedNetwork: StellarNetwork,
    actualNetwork: StellarNetwork | 'unknown' = 'unknown',
  ) {
    super(message);
    this.name = 'NetworkMismatchError';
    this.expectedNetwork = expectedNetwork;
    this.actualNetwork = actualNetwork;
  }
}

function normalizeNetwork(raw: string | undefined): StellarNetwork | null {
  const value = raw?.trim().toLowerCase();
  if (value === 'mainnet' || value === 'testnet') return value;
  return null;
}

/**
 * Resolved Stellar network from STELLAR_NETWORK.
 * In production, missing or invalid values throw (no silent testnet fallback).
 */
export function getStellarNetwork(): StellarNetwork {
  const parsed = normalizeNetwork(process.env.STELLAR_NETWORK);
  if (parsed) return parsed;

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'STELLAR_NETWORK must be explicitly set to "mainnet" or "testnet" in production',
    );
  }

  return 'testnet';
}

export function getNetworkPassphrase(network?: StellarNetwork): string {
  const resolved = network ?? getStellarNetwork();
  return resolved === 'mainnet' ? MAINNET_PASSPHRASE : TESTNET_PASSPHRASE;
}

export function getHorizonUrl(network?: StellarNetwork): string {
  const resolved = network ?? getStellarNetwork();
  return resolved === 'mainnet'
    ? 'https://horizon.stellar.org'
    : 'https://horizon-testnet.stellar.org';
}

export function networkFromPassphrase(passphrase: string): StellarNetwork | null {
  if (passphrase === MAINNET_PASSPHRASE) return 'mainnet';
  if (passphrase === TESTNET_PASSPHRASE) return 'testnet';
  return null;
}

/**
 * Compare two network identifiers (names or passphrases).
 */
export function assertNetworkMatch(
  expected: StellarNetwork | string,
  actual: StellarNetwork | string,
): void {
  const normalize = (value: StellarNetwork | string): StellarNetwork | null => {
    const asName = normalizeNetwork(value);
    if (asName) return asName;
    return networkFromPassphrase(value);
  };

  const expectedNetwork = normalize(expected);
  const actualNetwork = normalize(actual);

  if (!expectedNetwork || !actualNetwork) {
    throw new NetworkMismatchError(
      'Unable to compare Stellar networks — invalid network identifier',
      getStellarNetwork(),
      'unknown',
    );
  }

  if (expectedNetwork !== actualNetwork) {
    throw new NetworkMismatchError(
      `Network mismatch: expected ${expectedNetwork} but got ${actualNetwork}. ` +
        `Switch your wallet to ${expectedNetwork} or update server configuration.`,
      expectedNetwork,
      actualNetwork,
    );
  }
}

function parseWithPassphrase(xdr: string, passphrase: string): ParsedStellarTx | null {
  try {
    return TransactionBuilder.fromXDR(xdr, passphrase) as Transaction;
  } catch {
    try {
      return FeeBumpTransaction.fromXDR(xdr, passphrase);
    } catch {
      return null;
    }
  }
}

function signaturesValidForPassphrase(xdr: string, passphrase: string): boolean {
  const tx = parseWithPassphrase(xdr, passphrase);
  if (!tx) return false;

  const signatures = tx.signatures;
  if (!signatures?.length) return false;

  const signatureBase = tx.signatureBase();

  const signers = tx instanceof FeeBumpTransaction ? [tx.feeSource] : [tx.source];

  for (const signer of signers) {
    try {
      const keypair = Keypair.fromPublicKey(signer);
      for (const sig of signatures) {
        if (keypair.verify(signatureBase, sig.signature())) {
          return true;
        }
      }
    } catch {
      // try next signer
    }
  }

  return false;
}

/**
 * Parse signed XDR and ensure it belongs to the server's configured network.
 */
export function parseAndValidateXdr(signedXdr: string): ParsedStellarTx {
  const expectedNetwork = getStellarNetwork();
  const expectedPassphrase = getNetworkPassphrase(expectedNetwork);
  const alternateNetwork: StellarNetwork =
    expectedNetwork === 'mainnet' ? 'testnet' : 'mainnet';
  const alternatePassphrase = getNetworkPassphrase(alternateNetwork);

  if (signaturesValidForPassphrase(signedXdr, expectedPassphrase)) {
    const parsed = parseWithPassphrase(signedXdr, expectedPassphrase);
    if (parsed) return parsed;
  }

  if (signaturesValidForPassphrase(signedXdr, alternatePassphrase)) {
    throw new NetworkMismatchError(
      `Transaction was signed for ${alternateNetwork} but this server expects ${expectedNetwork}. ` +
        `Sign again on ${expectedNetwork} or contact support if the app network is wrong.`,
      expectedNetwork,
      alternateNetwork,
    );
  }

  throw new NetworkMismatchError(
    'Invalid signed transaction XDR or signature for the configured Stellar network',
    expectedNetwork,
    'unknown',
  );
}

/**
 * Ensure STELLAR_NETWORK_PASSPHRASE (if set) matches STELLAR_NETWORK.
 */
export function validateEnvNetworkPassphrase(): string | null {
  const fromEnv = process.env.STELLAR_NETWORK_PASSPHRASE?.trim();
  if (!fromEnv) return null;

  const expected = getNetworkPassphrase();
  if (fromEnv !== expected) {
    return `STELLAR_NETWORK_PASSPHRASE does not match STELLAR_NETWORK (${getStellarNetwork()})`;
  }
  return null;
}
