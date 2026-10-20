import { useState, useCallback, useEffect, useRef } from 'react';
import {
  connectFreighterWallet,
  getWalletStatus,
  isValidStellarAddress,
  FreighterError,
  WalletState,
  checkNetworkMatch,
} from '@/lib/freighter-utils';
import { getExpectedNetwork } from '@/lib/network-utils';

/**
 * Explicit lifecycle phases for the wallet flow. These drive accessible
 * announcements and the fallback UI so that every state (including rejection
 * and recovery) is reachable and describable.
 */
export type WalletPhase =
  | 'idle'
  | 'checking'
  | 'connecting'
  | 'awaiting-wallet' // handed off to wallet app / extension, waiting for return
  | 'connected'
  | 'rejected'
  | 'error'
  | 'unsupported';

export type WalletEnvironmentIssue =
  | 'no-window'
  | 'no-local-storage'
  | 'no-provider'
  | 'insecure-context';

export interface UseWalletReturn {
  state: WalletState & { isLoading: boolean };
  phase: WalletPhase;
  /** Actionable message for unsupported environments, or null when supported. */
  unsupportedReason: string | null;
  /** True when the page regained focus after a wallet handoff (mobile return). */
  returnedFromWallet: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  checkStatus: () => Promise<void>;
  /** Clears a rejection/error so the user can retry from a clean state. */
  recover: () => void;
}

const WALLET_STORAGE_KEY = 'freighter_wallet_connected';
const WALLET_ADDRESS_KEY = 'freighter_wallet_address';
const WALLET_HANDOFF_KEY = 'freighter_wallet_handoff_at';
// If the user returns within this window we treat it as a wallet handoff.
const HANDOFF_WINDOW_MS = 5 * 60 * 1000;

const UNSUPPORTED_MESSAGES: Record<WalletEnvironmentIssue, string> = {
  'no-window':
    'Wallet connection requires a browser. Open this page in a supported browser on desktop or mobile to connect Freighter.',
  'no-local-storage':
    'Your browser is blocking local storage, which the wallet needs to remember your session. Enable site storage or use a supported browser.',
  'no-provider':
    'Freighter was not detected. Install the Freighter extension (desktop) or open this page in the Freighter mobile browser, then try again.',
  'insecure-context':
    'Wallet connection requires a secure (HTTPS) page. Open this site over HTTPS to connect your wallet.',
};

function detectEnvironmentIssue(): WalletEnvironmentIssue | null {
  if (typeof window === 'undefined') return 'no-window';
  try {
    const probeKey = '__freighter_probe__';
    window.localStorage.setItem(probeKey, '1');
    window.localStorage.removeItem(probeKey);
  } catch {
    return 'no-local-storage';
  }
  if (typeof window.isSecureContext === 'boolean' && !window.isSecureContext) {
    return 'insecure-context';
  }
  return null;
}

/**
 * Hook for managing Freighter wallet connection and status
 */
export function useWallet(): UseWalletReturn {
  const expectedNetwork = getExpectedNetwork();
  
  const [state, setState] = useState<WalletState & { isLoading: boolean }>({
    isConnected: false,
    address: null,
    network: expectedNetwork,
    networkMismatch: false,
    isLoading: true,
    error: null,
  });
  const [phase, setPhase] = useState<WalletPhase>('checking');
  const [unsupportedReason, setUnsupportedReason] = useState<string | null>(null);
  const [returnedFromWallet, setReturnedFromWallet] = useState(false);
  const handoffPendingRef = useRef(false);

  // Check for existing connection on mount and attempt auto-reconnect
  useEffect(() => {
    const environmentIssue = detectEnvironmentIssue();
    if (environmentIssue) {
      setUnsupportedReason(UNSUPPORTED_MESSAGES[environmentIssue]);
      setPhase('unsupported');
      setState((prev) => ({ ...prev, isLoading: false }));
      return;
    }

    const attemptReconnect = async () => {
      const wasConnected = localStorage.getItem(WALLET_STORAGE_KEY) === 'true';
      const savedAddress = localStorage.getItem(WALLET_ADDRESS_KEY);
      
      if (wasConnected && savedAddress) {
        // Try silent reconnect
        try {
          await checkStatus();
        } catch (error) {
          // If reconnect fails, clear the connection state
          localStorage.removeItem(WALLET_STORAGE_KEY);
          localStorage.removeItem(WALLET_ADDRESS_KEY);
          setState((prev) => ({ ...prev, isLoading: false }));
          setPhase('error');
        }
      } else {
        setState((prev) => ({ ...prev, isLoading: false }));
        setPhase('idle');
      }
    };

    attemptReconnect();

    // Listen for network changes (Freighter fires storage events)
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === 'freighter-network') {
        checkStatus();
      }
    };

    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, []);

  // Detect return-from-wallet (mobile browser handoff) via visibility/focus.
  useEffect(() => {
    if (typeof document === 'undefined') return;

    const handleReturn = () => {
      if (document.visibilityState === 'hidden') return;
      const handoffAt = Number(sessionStorage.getItem(WALLET_HANDOFF_KEY) || 0);
      if (!handoffAt) return;
      const withinWindow = Date.now() - handoffAt < HANDOFF_WINDOW_MS;
      sessionStorage.removeItem(WALLET_HANDOFF_KEY);
      if (!withinWindow) return;

      handoffPendingRef.current = false;
      setReturnedFromWallet(true);
      // Re-check status so a completed handoff resolves to connected.
      checkStatus();
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') handleReturn();
    };

    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('focus', handleReturn);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('focus', handleReturn);
    };
  }, [checkStatus]);

  const checkStatus = useCallback(async () => {
    setState((prev) => ({ ...prev, isLoading: true }));
    try {
      const status = await getWalletStatus(expectedNetwork);
      setState({
        ...status,
        isLoading: false,
      });
      setPhase(status.isConnected ? 'connected' : 'idle');
    } catch (error) {
      setState((prev) => ({ ...prev, isLoading: false }));
      setPhase('error');
    }
  }, [expectedNetwork]);

  const connect = useCallback(async () => {
    if (unsupportedReason) {
      setPhase('unsupported');
      return;
    }

    setState((prev) => ({ ...prev, isLoading: true, error: null }));
    setPhase('connecting');
    setReturnedFromWallet(false);

    // Record the handoff so a return-from-wallet can be detected on mobile.
    try {
      sessionStorage.setItem(WALLET_HANDOFF_KEY, String(Date.now()));
    } catch {
      // sessionStorage may be unavailable; handoff detection is best-effort.
    }
    handoffPendingRef.current = true;
    setPhase('awaiting-wallet');

    try {
      const address = await connectFreighterWallet(expectedNetwork);
      
      // Persist connection state
      localStorage.setItem(WALLET_STORAGE_KEY, 'true');
      localStorage.setItem(WALLET_ADDRESS_KEY, address);
      sessionStorage.removeItem(WALLET_HANDOFF_KEY);
      handoffPendingRef.current = false;

      setState({
        isConnected: true,
        address,
        network: expectedNetwork,
        networkMismatch: false,
        isLoading: false,
        error: null,
      });
      setPhase('connected');
    } catch (error) {
      let errorMessage = 'Failed to connect wallet';
      let nextPhase: WalletPhase = 'error';

      if (error instanceof FreighterError) {
        switch (error.code) {
          case 'NOT_INSTALLED':
            errorMessage =
              'Freighter wallet is not installed. Install it from https://www.freighter.app, or open this page in the Freighter mobile browser.';
            setUnsupportedReason(UNSUPPORTED_MESSAGES['no-provider']);
            nextPhase = 'unsupported';
            break;
          case 'NOT_CONNECTED':
            errorMessage =
              'Wallet is not connected in Freighter. Please open Freighter and connect your account.';
            break;
          case 'USER_REJECTED':
            errorMessage =
              'You rejected the connection request. No changes were made — you can try again when ready.';
            nextPhase = 'rejected';
            break;
          case 'NETWORK_MISMATCH':
            errorMessage = error.message;
            break;
          default:
            errorMessage = error.message;
        }
      }

      sessionStorage.removeItem(WALLET_HANDOFF_KEY);
      handoffPendingRef.current = false;

      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: errorMessage,
      }));
      setPhase(nextPhase);

      throw error;
    }
  }, [expectedNetwork, unsupportedReason]);

  const recover = useCallback(() => {
    setState((prev) => ({ ...prev, error: null, isLoading: false }));
    setReturnedFromWallet(false);
    setPhase((prev) =>
      prev === 'rejected' || prev === 'error' ? 'idle' : prev
    );
  }, []);

  const disconnect = useCallback(() => {
    localStorage.removeItem(WALLET_STORAGE_KEY);
    localStorage.removeItem(WALLET_ADDRESS_KEY);
    sessionStorage.removeItem(WALLET_HANDOFF_KEY);
    handoffPendingRef.current = false;
    setState({
      isConnected: false,
      address: null,
      network: expectedNetwork,
      networkMismatch: false,
      isLoading: false,
      error: null,
    });
    setReturnedFromWallet(false);
    setPhase('idle');
  }, [expectedNetwork]);

  return {
    state,
    phase,
    unsupportedReason,
    returnedFromWallet,
    connect,
    disconnect,
    checkStatus,
    recover,
  };
}
