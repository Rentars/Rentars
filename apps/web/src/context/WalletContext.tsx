'use client';

import {
    createContext,
    useContext,
    ReactNode,
    useEffect,
    useCallback,
    useMemo,
    useRef,
    useState,
} from 'react';
import { useWallet, UseWalletReturn } from '@/hooks/useWallet';

interface WalletContextType extends UseWalletReturn {
    isReady: boolean;
    /** Human-readable announcement for the current wallet state (for ARIA live regions). */
    announcement: string;
    /** True when no wallet provider is available in this environment. */
    isUnsupported: boolean;
    /** Actionable guidance shown when the wallet provider is unavailable. */
    unsupportedMessage: string;
}

const WalletContext = createContext<WalletContextType | undefined>(undefined);

const UNSUPPORTED_MESSAGE =
    'No Stellar wallet was detected in this browser. Install a supported wallet extension ' +
    '(for example Freighter or xBull), or open this page in a desktop browser with the wallet ' +
    'extension enabled, then reload to connect.';

function detectWalletProvider(): boolean {
    if (typeof window === 'undefined') {
        return true; // Assume supported during SSR; resolved on the client.
    }
    const win = window as unknown as Record<string, unknown>;
    return Boolean(win.freighter || win.freighterApi || win.xBull || win.stellar);
}

export function WalletProvider({ children }: { children: ReactNode }) {
    const wallet = useWallet();
    const isReady = !wallet.state.isLoading;

    const [isUnsupported, setIsUnsupported] = useState(false);
    const [announcement, setAnnouncement] = useState('');

    const previousStateRef = useRef(wallet.state);
    const returnFocusRef = useRef<HTMLElement | null>(null);
    const wasConnectingRef = useRef(false);

    // Detect wallet provider availability on mount.
    useEffect(() => {
        setIsUnsupported(!detectWalletProvider());
    }, []);

    // Auto-check status on network change
    useEffect(() => {
        const handleNetworkChange = () => {
            wallet.checkStatus();
        };

        window.addEventListener('stellar-network-change', handleNetworkChange);
        return () => window.removeEventListener('stellar-network-change', handleNetworkChange);
    }, [wallet]);

    // Announce connection, signing, and rejection state transitions.
    useEffect(() => {
        const prev = previousStateRef.current;
        const next = wallet.state;
        let message = '';

        if (next.isConnecting && !prev.isConnecting) {
            message = 'Connecting to your wallet. Please approve the request in your wallet.';
        } else if (next.isConnected && !prev.isConnected) {
            message = next.address
                ? `Wallet connected: ${next.address.slice(0, 6)}...${next.address.slice(-4)}.`
                : 'Wallet connected.';
        } else if (next.isSigning && !prev.isSigning) {
            message = 'Waiting for you to sign the transaction in your wallet.';
        } else if (!next.isSigning && prev.isSigning && next.error) {
            message = `Transaction signing was rejected or failed: ${next.error}`;
        } else if (!next.isSigning && prev.isSigning && !next.error) {
            message = 'Transaction signed successfully.';
        } else if (next.error && next.error !== prev.error) {
            message = `Wallet error: ${next.error}`;
        } else if (!next.isConnected && prev.isConnected) {
            message = 'Wallet disconnected.';
        }

        if (message) {
            setAnnouncement(message);
        }

        previousStateRef.current = next;
    }, [wallet.state]);

    // Focus management: capture the triggering element before connecting and
    // restore focus to it when returning from the wallet.
    useEffect(() => {
        if (wallet.state.isConnecting && !wasConnectingRef.current) {
            if (typeof document !== 'undefined') {
                returnFocusRef.current = document.activeElement as HTMLElement | null;
            }
        }

        if (!wallet.state.isConnecting && wasConnectingRef.current) {
            const target = returnFocusRef.current;
            if (target && typeof target.focus === 'function' && document.contains(target)) {
                target.focus();
            }
            returnFocusRef.current = null;
        }

        wasConnectingRef.current = wallet.state.isConnecting;
    }, [wallet.state.isConnecting]);

    const contextValue = useMemo<WalletContextType>(
        () => ({
            ...wallet,
            isReady,
            announcement,
            isUnsupported,
            unsupportedMessage: UNSUPPORTED_MESSAGE,
        }),
        [wallet, isReady, announcement, isUnsupported],
    );

    return (
        <WalletContext.Provider value={contextValue}>
            {/* ARIA live region announcing wallet state changes to assistive tech. */}
            <div
                role="status"
                aria-live="polite"
                aria-atomic="true"
                className="sr-only"
                data-testid="wallet-live-region"
            >
                {announcement}
            </div>

            {isUnsupported && (
                <div
                    role="alert"
                    aria-live="assertive"
                    className="wallet-unsupported-notice"
                    data-testid="wallet-unsupported-notice"
                >
                    <p>{UNSUPPORTED_MESSAGE}</p>
                    <a
                        href="https://www.freighter.app/"
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        Get a supported wallet
                    </a>
                </div>
            )}

            {children}
        </WalletContext.Provider>
    );
}

export function useWalletContext() {
    const context = useContext(WalletContext);
    if (context === undefined) {
        throw new Error('useWalletContext must be used within a WalletProvider');
    }
    return context;
}