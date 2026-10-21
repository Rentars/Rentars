'use client';

import { ReactNode } from 'react';
import { useWalletContext } from '@/context/WalletContext';
import { WalletConnectButton } from './WalletConnectButton';
import { WalletErrorDisplay } from './WalletErrorDisplay';

interface WalletRequiredGuardProps {
    children: ReactNode;
    fallback?: ReactNode;
    requireNetwork?: 'testnet' | 'mainnet';
    className?: string;
}

export function WalletRequiredGuard({
                                        children,
                                        fallback,
                                        requireNetwork,
                                        className = '',
                                    }: WalletRequiredGuardProps) {
    const { state, isReady } = useWalletContext();

    // Still loading
    if (!isReady || state.isLoading) {
        return (
            <div
                role="status"
                aria-live="polite"
                aria-atomic="true"
                className={`flex items-center justify-center p-8 ${className}`}
            >
                <div
                    className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"
                    aria-hidden="true"
                ></div>
                <span className="ml-3 text-gray-600">Checking wallet connection...</span>
            </div>
        );
    }

    // Not connected
    if (!state.isConnected) {
        if (fallback) {
            return <>{fallback}</>;
        }

        return (
            <div className={`flex flex-col items-center justify-center p-8 space-y-4 ${className}`}>
                <div className="text-center">
                    <svg
                        className="w-16 h-16 text-gray-400 mx-auto mb-4"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                    >
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={1.5}
                            d="M3 10h18M3 14h18m-9-4v8m-7 0h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
                        />
                    </svg>
                    <h3 className="text-lg font-medium text-gray-900">Wallet Required</h3>
                    <p className="text-sm text-gray-500 mt-1">
                        Connect your Stellar wallet to continue with this action
                    </p>
                </div>
                <WalletConnectButton />
                <WalletErrorDisplay className="w-full max-w-md mt-4" />
            </div>
        );
    }

    // Network mismatch check
    if (requireNetwork && state.network !== requireNetwork) {
        return (
            <div className={`flex flex-col items-center justify-center p-8 space-y-4 ${className}`}>
                <div className="text-center">
                    <svg
                        className="w-16 h-16 text-yellow-400 mx-auto mb-4"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                    >
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={1.5}
                            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                        />
                    </svg>
                    <h3 className="text-lg font-medium text-gray-900">Network Mismatch</h3>
                    <p className="text-sm text-gray-500 mt-1">
                        This action requires {requireNetwork}. Please switch your wallet network.
                    </p>
                    <p className="text-xs text-gray-400 mt-2">
                        Current network: <span className="font-medium capitalize">{state.network}</span>
                    </p>
                </div>
                <WalletErrorDisplay className="w-full max-w-md" />
            </div>
        );
    }

    // All checks passed
    return <>{children}</>;
}