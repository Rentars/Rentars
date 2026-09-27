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

  if (!isReady || state.isLoading) {
    return (
      <div
        className={`flex items-center justify-center p-8 ${className}`}
        role="status"
        aria-live="polite"
      >
        <div
          className="h-8 w-8 animate-spin rounded-full border-b-2 border-blue-600"
          aria-hidden="true"
        />
        <span className="ml-3 text-gray-600">Checking wallet connection...</span>
      </div>
    );
  }

  if (state.unsupportedEnvironment) {
    return (
      <div
        className={`flex flex-col items-center justify-center space-y-4 p-8 ${className}`}
        role="alert"
      >
        <h3 className="text-lg font-medium text-gray-900">Wallet not supported here</h3>
        <p className="max-w-md text-center text-sm text-gray-600">{state.unsupportedMessage}</p>
        <a
          href="https://www.freighter.app"
          target="_blank"
          rel="noreferrer"
          className="text-sm text-blue-600 underline focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          Freighter help & supported devices
        </a>
      </div>
    );
  }

  if (!state.isConnected) {
    if (fallback) {
      return <>{fallback}</>;
    }

    return (
      <div className={`flex flex-col items-center justify-center space-y-4 p-8 ${className}`}>
        <div className="text-center">
          <h3 className="text-lg font-medium text-gray-900">Wallet Required</h3>
          <p className="mt-1 text-sm text-gray-500">
            Connect your Stellar wallet to continue with this action
          </p>
        </div>
        <WalletConnectButton />
        <WalletErrorDisplay className="mt-4 w-full max-w-md" />
      </div>
    );
  }

  if (requireNetwork && state.network !== requireNetwork) {
    return (
      <div
        className={`flex flex-col items-center justify-center space-y-4 p-8 ${className}`}
        role="alert"
      >
        <div className="text-center">
          <h3 className="text-lg font-medium text-gray-900">Network Mismatch</h3>
          <p className="mt-1 text-sm text-gray-500">
            This action requires {requireNetwork}. Please switch your wallet network.
          </p>
          <p className="mt-2 text-xs text-gray-400">
            Current network: <span className="font-medium capitalize">{state.network}</span>
          </p>
        </div>
        <WalletErrorDisplay className="w-full max-w-md" />
      </div>
    );
  }

  return <>{children}</>;
}
