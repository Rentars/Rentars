'use client';

import { useWalletContext } from '@/context/WalletContext';

interface AccountSwitchBannerProps {
  /** Address that owns the in-progress booking / signing flow. */
  bookingOwnerAddress?: string | null;
  onRestartFlow?: () => void;
  className?: string;
}

/**
 * Surfaces Freighter account switches and blocks continuing under a mismatched
 * signing identity (#620).
 */
export function AccountSwitchBanner({
  bookingOwnerAddress,
  onRestartFlow,
  className = '',
}: AccountSwitchBannerProps) {
  const { state, confirmAccountSwitch, disconnect } = useWalletContext();

  const mismatchesBooking =
    Boolean(bookingOwnerAddress) &&
    Boolean(state.address) &&
    bookingOwnerAddress !== state.address;

  if (!state.accountChanged && !mismatchesBooking) {
    return null;
  }

  const message = mismatchesBooking
    ? 'Your Freighter account no longer matches the wallet that started this booking. Restart the flow with the active account before signing.'
    : `Freighter switched accounts${state.previousAddress ? ` from ${shorten(state.previousAddress)}` : ''}${state.address ? ` to ${shorten(state.address)}` : ''}. Confirm to continue, or disconnect.`;

  return (
    <div
      role="alert"
      aria-live="assertive"
      className={`rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-900 ${className}`}
      data-testid="account-switch-banner"
    >
      <p className="text-sm font-medium">{message}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {mismatchesBooking ? (
          <button
            type="button"
            className="rounded-md bg-amber-700 px-3 py-1.5 text-sm text-white hover:bg-amber-800 focus:outline-none focus:ring-2 focus:ring-amber-500"
            onClick={() => {
              disconnect();
              onRestartFlow?.();
            }}
          >
            Restart booking flow
          </button>
        ) : (
          <button
            type="button"
            className="rounded-md bg-amber-700 px-3 py-1.5 text-sm text-white hover:bg-amber-800 focus:outline-none focus:ring-2 focus:ring-amber-500"
            onClick={confirmAccountSwitch}
          >
            Use new account
          </button>
        )}
        <button
          type="button"
          className="rounded-md border border-amber-400 bg-white px-3 py-1.5 text-sm text-amber-900 hover:bg-amber-100 focus:outline-none focus:ring-2 focus:ring-amber-500"
          onClick={disconnect}
        >
          Disconnect
        </button>
      </div>
    </div>
  );
}

function shorten(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
