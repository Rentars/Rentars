import { validateNetworkConsistency } from '@/lib/network-utils';
import { isValidStellarAddress } from '@/lib/isValidStellarAddress';

// ── Lazy Freighter API ──────────────────────────────────────────────────────
// @stellar/freighter-api (~150KB) is only needed when the wallet/booking flow
// runs. Import it on demand so public pages don't carry the wallet SDK.

let _freighterApi: typeof import('@stellar/freighter-api') | null = null;

async function freighterApi(): Promise<typeof import('@stellar/freighter-api')> {
  if (!_freighterApi) {
    _freighterApi = await import('@stellar/freighter-api');
  }
  return _freighterApi;
}

export interface WalletState {
  isConnected: boolean;
  address: string | null;
  network: 'testnet' | 'mainnet';
  networkMismatch: boolean;
  networkValidated: boolean;
  isLoading: boolean;
  error: string | null;
}

export class FreighterError extends Error {
  constructor(
    message: string,
    public code: 'NOT_INSTALLED' | 'NOT_CONNECTED' | 'SIGN_FAILED' | 'USER_REJECTED' | 'NETWORK_ERROR' | 'NETWORK_MISMATCH' | 'TIMEOUT' = 'NETWORK_ERROR'
  ) {
    super(message);
    this.name = 'FreighterError';
  }
}

const FREIGHTER_ERROR_MESSAGES: Record<FreighterError['code'], string> = {
  NOT_INSTALLED: 'Freighter wallet is not installed. Please install it from https://www.freighter.app',
  NOT_CONNECTED: 'Wallet is not connected in Freighter. Please open Freighter and connect your account.',
  SIGN_FAILED: 'Failed to sign the transaction. Please try again.',
  USER_REJECTED: 'You rejected the connection request. Please try again.',
  NETWORK_ERROR: 'Freighter wallet request failed. Please try again.',
  NETWORK_MISMATCH: 'Freighter is on a different network than this app.',
  TIMEOUT: 'Signing request timed out. Please check your wallet and try again.',
};

export function getFreighterErrorMessage(
  error: unknown,
  fallback = 'Freighter wallet request failed. Please try again.',
): string {
  if (error instanceof FreighterError) {
    return FREIGHTER_ERROR_MESSAGES[error.code] ?? error.message;
  }

  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (lower.includes('not installed')) return FREIGHTER_ERROR_MESSAGES.NOT_INSTALLED;
    if (lower.includes('not connected')) return FREIGHTER_ERROR_MESSAGES.NOT_CONNECTED;
    if (lower.includes('rejected')) return FREIGHTER_ERROR_MESSAGES.USER_REJECTED;
    if (lower.includes('timed out')) return FREIGHTER_ERROR_MESSAGES.TIMEOUT;
    if (lower.includes('network mismatch')) return error.message;
    return error.message;
  }

  return fallback;
}

export async function getWalletNetwork(): Promise<'testnet' | 'mainnet'> {
  try {
    const api = await freighterApi();
    const result = await api.getNetwork();
    if (result.error) {
      throw new FreighterError('Failed to get wallet network', 'NETWORK_ERROR');
    }
    return result.network === 'PUBLIC' ? 'mainnet' : 'testnet';
  } catch (error) {
    if (error instanceof FreighterError) throw error;
    return 'testnet';
  }
}

export async function checkNetworkMatch(expectedNetwork: 'testnet' | 'mainnet'): Promise<boolean> {
  try {
    const walletNetwork = await getWalletNetwork();
    return walletNetwork === expectedNetwork;
  } catch (error) {
    return false;
  }
}

export async function isFreighterInstalled(): Promise<boolean> {
  try {
    const api = await freighterApi();
    const result = await api.isConnected();
    return result.isConnected;
  } catch (error) {
    return false;
  }
}

export async function getFreighterPublicKey(): Promise<string> {
  try {
    const api = await freighterApi();
    const result = await api.getAddress();
    if (result.error) {
      if (result.error.message?.includes('Not connected')) {
        throw new FreighterError('Wallet not connected. Please open Freighter and connect.', 'NOT_CONNECTED');
      }
      throw new FreighterError(result.error.message || 'Failed to get wallet address', 'NETWORK_ERROR');
    }
    if (!result.address) {
      throw new FreighterError('No address returned from wallet', 'NOT_CONNECTED');
    }
    return result.address;
  } catch (error) {
    if (error instanceof FreighterError) throw error;
    throw new FreighterError(
      error instanceof Error ? error.message : 'Failed to get wallet address',
      'NETWORK_ERROR'
    );
  }
}

export async function signWithFreighter(
  xdr: string,
  network: 'testnet' | 'mainnet',
  options?: { timeout?: number }
): Promise<string> {
  const timeout = options?.timeout ?? 60000;

  try {
    const walletNetwork = await getWalletNetwork();
    if (walletNetwork !== network) {
      throw new FreighterError(
        `Wallet is on ${walletNetwork} but transaction requires ${network}. Please switch networks in Freighter.`,
        'NETWORK_MISMATCH'
      );
    }

    const networkPassphrase = getNetworkPassphrase(network);

    const signPromise = (await freighterApi()).signTransaction(xdr, { networkPassphrase });
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new FreighterError('Signing request timed out', 'TIMEOUT')), timeout);
    });

    const result = await Promise.race([signPromise, timeoutPromise]);

    if (result.error) {
      if (result.error.message?.includes('rejected')) {
        throw new FreighterError('Transaction signing rejected by user', 'USER_REJECTED');
      }
      throw new FreighterError(result.error.message || 'Failed to sign transaction', 'SIGN_FAILED');
    }

    if (!result.signedTxXdr || !result.signedTxXdr.trim()) {
      throw new FreighterError('No signed transaction returned', 'SIGN_FAILED');
    }

    return result.signedTxXdr;
  } catch (error) {
    if (error instanceof FreighterError) throw error;
    throw new FreighterError(
      error instanceof Error ? error.message : 'Transaction signing failed',
      'SIGN_FAILED'
    );
  }
}

export function getNetworkPassphrase(network: 'testnet' | 'mainnet'): string {
  const passphrases = {
    testnet: 'Test SDF Network ; September 2015',
    mainnet: 'Public Global Stellar Network ; September 2015',
  };
  return passphrases[network];
}

export async function connectFreighterWallet(
  expectedNetwork?: 'testnet' | 'mainnet',
  apiUrl?: string,
): Promise<string> {
  const installed = await isFreighterInstalled();
  if (!installed) {
    throw new FreighterError(
      'Freighter wallet is not installed. Please install it from https://www.freighter.app',
      'NOT_INSTALLED'
    );
  }

  const address = await getFreighterPublicKey();
  if (!isValidStellarAddress(address)) {
    throw new FreighterError('Invalid wallet address format', 'NETWORK_ERROR');
  }

  if (expectedNetwork) {
    const walletNetwork = await getWalletNetwork();
    if (walletNetwork !== expectedNetwork) {
      throw new FreighterError(
        `Wallet is on ${walletNetwork} but app expects ${expectedNetwork}. Please switch networks in Freighter.`,
        'NETWORK_MISMATCH'
      );
    }
  }

  if (expectedNetwork && apiUrl) {
    const mismatchReason = await validateNetworkConsistency(expectedNetwork, apiUrl);
    if (mismatchReason) {
      throw new FreighterError(mismatchReason, 'NETWORK_MISMATCH');
    }
  }

  return address;
}

export async function getWalletStatus(
  expectedNetwork?: 'testnet' | 'mainnet',
  apiUrl?: string,
): Promise<WalletState> {
  try {
    const installed = await isFreighterInstalled();
    if (!installed) {
      return {
        isConnected: false,
        address: null,
        network: expectedNetwork || 'testnet',
        networkMismatch: false,
        networkValidated: false,
        isLoading: false,
        error: 'Freighter wallet not installed',
      };
    }

    const address = await getFreighterPublicKey();
    const walletNetwork = await getWalletNetwork();
    const localMismatch = expectedNetwork ? walletNetwork !== expectedNetwork : false;

    let networkMismatch = localMismatch;
    let networkValidated = false;
    let errorMsg: string | null = localMismatch
      ? `Wallet is on ${walletNetwork} but app expects ${expectedNetwork}. Please switch networks in Freighter.`
      : null;

    if (!localMismatch && apiUrl) {
      const mismatchReason = await validateNetworkConsistency(walletNetwork, apiUrl);
      if (mismatchReason) {
        networkMismatch = true;
        errorMsg = mismatchReason;
      } else {
        networkValidated = true;
      }
    }

    return {
      isConnected: true,
      address,
      network: walletNetwork,
      networkMismatch,
      networkValidated,
      isLoading: false,
      error: errorMsg,
    };
  } catch (error) {
    return {
      isConnected: false,
      address: null,
      network: expectedNetwork || 'testnet',
      networkMismatch: false,
      networkValidated: false,
      isLoading: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
