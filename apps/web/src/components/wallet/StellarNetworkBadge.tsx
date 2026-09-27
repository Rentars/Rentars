'use client';

import { getExpectedNetwork, getExpectedNetworkLabel } from '@/lib/network-utils';

interface StellarNetworkBadgeProps {
  /** When set, highlights the wallet network during signing */
  walletNetwork?: 'testnet' | 'mainnet' | null;
  className?: string;
}

export function StellarNetworkBadge({ walletNetwork, className = '' }: StellarNetworkBadgeProps) {
  const expected = getExpectedNetwork();
  const label = getExpectedNetworkLabel();
  const mismatch = walletNetwork != null && walletNetwork !== expected;

  return (
    <div
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${className} ${
        mismatch
          ? 'border-yellow-300 bg-yellow-50 text-yellow-900'
          : 'border-blue-200 bg-blue-50 text-blue-900'
      }`}
      aria-live="polite"
    >
      <span
        className={`h-2 w-2 rounded-full ${mismatch ? 'bg-yellow-500' : 'bg-blue-600'}`}
        aria-hidden
      />
      <span>
        Stellar {label}
        {walletNetwork != null && (
          <span className="text-[10px] font-normal opacity-80">
            {' '}
            · wallet: {walletNetwork}
          </span>
        )}
      </span>
    </div>
  );
}
