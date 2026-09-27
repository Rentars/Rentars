import { useState, useCallback, useEffect, useRef } from 'react';
import {
  connectFreighterWallet,
  getWalletStatus,
  FreighterError,
  WalletState,
  isUnsupportedWalletEnvironment,
  getUnsupportedEnvironmentMessage,
} from '@/lib/freighter-utils';
import { getExpectedNetwork } from '@/lib/network-utils';

export interface UseWalletReturn {
  state: WalletState & {
    isLoading: boolean;
    /** True when Freighter address differs from the address this session started with. */
    accountChanged: boolean;
    /** Previous address before the most recent account switch (if any). */
    previousAddress: string | null;
    /** Environment cannot complete Freighter handoff (unsupported mobile/browser). */
    unsupportedEnvironment: boolean;
    unsupportedMessage: string | null;
  };
  connect: () => Promise<void>;
  disconnect: () => void;
  checkStatus: () => Promise<void>;
  /** Acknowledge an account switch and bind the session to the new address. */
  confirmAccountSwitch: () => void;
  /**
   * Returns true when `expectedAddress` matches the live wallet address.
   * Clears stale signing context and throws if the account changed mid-flow.
   */
  assertSigningAddress: (expectedAddress: string) => Promise<string>;
}

const WALLET_STORAGE_KEY = 'freighter_wallet_connected';
const WALLET_ADDRESS_KEY = 'freighter_wallet_address';
const ACCOUNT_POLL_MS = 3_000;

/**
 * Hook for managing Freighter wallet connection, status, and account switching (#620).
 */
export function useWallet(): UseWalletReturn {
  const expectedNetwork = getExpectedNetwork();

  const [state, setState] = useState<UseWalletReturn['state']>({
    isConnected: false,
    address: null,
    network: expectedNetwork,
    networkMismatch: false,
    isLoading: true,
    error: null,
    accountChanged: false,
    previousAddress: null,
    unsupportedEnvironment: false,
    unsupportedMessage: null,
  });

  const sessionAddressRef = useRef<string | null>(null);
  const checkStatusRef = useRef<() => Promise<void>>(async () => undefined);

  const clearPersisted = () => {
    localStorage.removeItem(WALLET_STORAGE_KEY);
    localStorage.removeItem(WALLET_ADDRESS_KEY);
  };

  const applyStatus = useCallback(
    (status: WalletState, opts?: { fromPoll?: boolean }) => {
      const live = status.address;
      const session = sessionAddressRef.current;

      let accountChanged = false;
      let previousAddress: string | null = null;

      if (opts?.fromPoll && session && live && live !== session) {
        accountChanged = true;
        previousAddress = session;
        // Invalidate stale signing context immediately.
        window.dispatchEvent(
          new CustomEvent('rentars:wallet-account-changed', {
            detail: { previous: session, current: live },
          }),
        );
      }

      if (live) {
        localStorage.setItem(WALLET_STORAGE_KEY, 'true');
        localStorage.setItem(WALLET_ADDRESS_KEY, live);
        if (!sessionAddressRef.current) {
          sessionAddressRef.current = live;
        }
      }

      setState((prev) => ({
        ...status,
        isLoading: false,
        accountChanged: accountChanged || (prev.accountChanged && live !== session),
        previousAddress: accountChanged ? previousAddress : prev.previousAddress,
        unsupportedEnvironment: prev.unsupportedEnvironment,
        unsupportedMessage: prev.unsupportedMessage,
      }));
    },
    [],
  );

  const checkStatus = useCallback(async () => {
    setState((prev) => ({ ...prev, isLoading: true }));
    const status = await getWalletStatus(expectedNetwork);

    if (!status.isConnected) {
      if (sessionAddressRef.current) {
        // Wallet disconnected externally — clear local session.
        sessionAddressRef.current = null;
        clearPersisted();
      }
      setState((prev) => ({
        ...status,
        isLoading: false,
        accountChanged: false,
        previousAddress: null,
        unsupportedEnvironment: prev.unsupportedEnvironment,
        unsupportedMessage: prev.unsupportedMessage,
      }));
      return;
    }

    applyStatus(status, { fromPoll: true });
  }, [expectedNetwork, applyStatus]);

  checkStatusRef.current = checkStatus;

  useEffect(() => {
    const unsupported = isUnsupportedWalletEnvironment();
    if (unsupported) {
      setState((prev) => ({
        ...prev,
        isLoading: false,
        unsupportedEnvironment: true,
        unsupportedMessage: getUnsupportedEnvironmentMessage(),
      }));
      return;
    }

    const attemptReconnect = async () => {
      const wasConnected = localStorage.getItem(WALLET_STORAGE_KEY) === 'true';
      const savedAddress = localStorage.getItem(WALLET_ADDRESS_KEY);

      if (wasConnected && savedAddress) {
        sessionAddressRef.current = savedAddress;
        try {
          await checkStatusRef.current();
        } catch {
          clearPersisted();
          sessionAddressRef.current = null;
          setState((prev) => ({ ...prev, isLoading: false }));
        }
      } else {
        setState((prev) => ({ ...prev, isLoading: false }));
      }
    };

    attemptReconnect();

    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === 'freighter-network' || e.key === WALLET_ADDRESS_KEY) {
        checkStatusRef.current();
      }
    };

    const handleFocus = () => {
      checkStatusRef.current();
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        checkStatusRef.current();
      }
    };

    window.addEventListener('storage', handleStorageChange);
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibility);

    const poll = window.setInterval(() => {
      if (sessionAddressRef.current) {
        checkStatusRef.current();
      }
    }, ACCOUNT_POLL_MS);

    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.clearInterval(poll);
    };
  }, []);

  const connect = useCallback(async () => {
    if (isUnsupportedWalletEnvironment()) {
      const msg = getUnsupportedEnvironmentMessage();
      setState((prev) => ({
        ...prev,
        isLoading: false,
        unsupportedEnvironment: true,
        unsupportedMessage: msg,
        error: msg,
      }));
      throw new FreighterError(msg, 'NOT_INSTALLED');
    }

    setState((prev) => ({ ...prev, isLoading: true, error: null }));

    try {
      const address = await connectFreighterWallet(expectedNetwork);

      sessionAddressRef.current = address;
      localStorage.setItem(WALLET_STORAGE_KEY, 'true');
      localStorage.setItem(WALLET_ADDRESS_KEY, address);

      setState({
        isConnected: true,
        address,
        network: expectedNetwork,
        networkMismatch: false,
        isLoading: false,
        error: null,
        accountChanged: false,
        previousAddress: null,
        unsupportedEnvironment: false,
        unsupportedMessage: null,
      });
    } catch (error) {
      let errorMessage = 'Failed to connect wallet';

      if (error instanceof FreighterError) {
        switch (error.code) {
          case 'NOT_INSTALLED':
            errorMessage =
              'Freighter wallet is not installed. Please install it from https://www.freighter.app';
            break;
          case 'NOT_CONNECTED':
            errorMessage =
              'Wallet is not connected in Freighter. Please open Freighter and connect your account.';
            break;
          case 'USER_REJECTED':
            errorMessage = 'You rejected the connection request. Please try again.';
            break;
          case 'NETWORK_MISMATCH':
            errorMessage = error.message;
            break;
          default:
            errorMessage = error.message;
        }
      }

      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: errorMessage,
      }));

      throw error;
    }
  }, [expectedNetwork]);

  const disconnect = useCallback(() => {
    clearPersisted();
    sessionAddressRef.current = null;
    setState({
      isConnected: false,
      address: null,
      network: expectedNetwork,
      networkMismatch: false,
      isLoading: false,
      error: null,
      accountChanged: false,
      previousAddress: null,
      unsupportedEnvironment: false,
      unsupportedMessage: null,
    });
    window.dispatchEvent(new CustomEvent('rentars:wallet-disconnected'));
  }, [expectedNetwork]);

  const confirmAccountSwitch = useCallback(() => {
    const live = state.address;
    if (live) {
      sessionAddressRef.current = live;
      localStorage.setItem(WALLET_ADDRESS_KEY, live);
    }
    setState((prev) => ({
      ...prev,
      accountChanged: false,
      previousAddress: null,
    }));
  }, [state.address]);

  const assertSigningAddress = useCallback(async (expectedAddress: string) => {
    const status = await getWalletStatus(expectedNetwork);
    const live = status.address;
    if (!live) {
      throw new FreighterError('Wallet is not connected', 'NOT_CONNECTED');
    }
    if (live !== expectedAddress) {
      sessionAddressRef.current = expectedAddress;
      setState((prev) => ({
        ...prev,
        ...status,
        isLoading: false,
        accountChanged: true,
        previousAddress: expectedAddress,
      }));
      window.dispatchEvent(
        new CustomEvent('rentars:wallet-account-changed', {
          detail: { previous: expectedAddress, current: live },
        }),
      );
      throw new FreighterError(
        'Wallet account changed. Restart the booking flow with the active account before signing.',
        'USER_REJECTED',
      );
    }
    return live;
  }, [expectedNetwork]);

  return {
    state,
    connect,
    disconnect,
    checkStatus,
    confirmAccountSwitch,
    assertSigningAddress,
  };
}
