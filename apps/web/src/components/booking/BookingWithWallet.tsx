'use client';

import { useState } from 'react';
import { useWalletBookingActions } from '@/hooks/useWalletBookingActions';
import { WalletRequiredGuard } from '@/components/wallet/WalletRequiredGuard';
import { WalletStatusBadge } from '@/components/wallet/WalletStatusBadge';
import { AccountSwitchBanner } from '@/components/wallet/AccountSwitchBanner';
import { useWalletContext } from '@/context/WalletContext';
import type { Booking } from '@/types/booking';

interface BookingWithWalletProps {
  bookingId: string;
  booking: Booking;
  onUpdate?: (updated: Booking) => void;
}

export function BookingWithWallet({ bookingId, booking, onUpdate }: BookingWithWalletProps) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [flowRestartKey, setFlowRestartKey] = useState(0);
  const { state, assertSigningAddress } = useWalletContext();
  const {
    confirmWithWallet,
    completeWithWallet,
    cancelWithWallet,
    disputeWithWallet,
    isWalletRequired,
    walletError,
    pendingAction,
    actionError,
  } = useWalletBookingActions(bookingId, onUpdate);

  const bookingOwner = booking.tenant_wallet ?? null;

  const handleAction = async (action: () => Promise<Booking | null>) => {
    setIsProcessing(true);
    try {
      if (bookingOwner) {
        await assertSigningAddress(bookingOwner);
      }
      await action();
    } catch (error) {
      console.error('Action failed:', error);
    } finally {
      setIsProcessing(false);
    }
  };

  const isLoading = isProcessing || !!pendingAction;
  const blockedByAccountSwitch =
    state.accountChanged ||
    (Boolean(bookingOwner) && Boolean(state.address) && bookingOwner !== state.address);

  return (
    <WalletRequiredGuard requireNetwork="testnet">
      <div className="space-y-4" key={flowRestartKey}>
        <AccountSwitchBanner
          bookingOwnerAddress={bookingOwner}
          onRestartFlow={() => setFlowRestartKey((k) => k + 1)}
        />

        <div className="flex items-center justify-between">
          <h3 className="text-lg font-medium">Booking Actions</h3>
          <WalletStatusBadge />
        </div>

        {(walletError || actionError) && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4" role="alert">
            <p className="text-sm text-red-700">{walletError || actionError}</p>
          </div>
        )}

        <div className="rounded-lg bg-gray-50 p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-500">Status</span>
            <span
              className={`rounded-full px-2 py-1 text-xs font-medium ${
                booking.status === 'confirmed'
                  ? 'bg-green-100 text-green-800'
                  : booking.status === 'pending'
                    ? 'bg-yellow-100 text-yellow-800'
                    : booking.status === 'completed'
                      ? 'bg-blue-100 text-blue-800'
                      : booking.status === 'cancelled'
                        ? 'bg-red-100 text-red-800'
                        : 'bg-gray-100 text-gray-800'
              }`}
            >
              {booking.status}
            </span>
          </div>
          {booking.escrow_id && (
            <div className="mt-2 flex items-center justify-between">
              <span className="text-sm font-medium text-gray-500">Escrow</span>
              <span
                className={`text-sm ${
                  booking.escrow_status === 'released'
                    ? 'text-green-600'
                    : booking.escrow_status === 'locked'
                      ? 'text-yellow-600'
                      : 'text-gray-600'
                }`}
              >
                {booking.escrow_status || 'Pending'}
              </span>
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-3">
          {booking.status === 'pending' && (
            <button
              onClick={() => handleAction(confirmWithWallet)}
              disabled={isLoading || isWalletRequired || blockedByAccountSwitch}
              className="rounded-lg bg-blue-600 px-4 py-2 text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isLoading && pendingAction === 'confirm' ? 'Confirming...' : 'Confirm Booking'}
            </button>
          )}

          {booking.status === 'confirmed' && (
            <>
              <button
                onClick={() => handleAction(completeWithWallet)}
                disabled={isLoading || isWalletRequired || blockedByAccountSwitch}
                className="rounded-lg bg-green-600 px-4 py-2 text-white transition-colors hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isLoading && pendingAction === 'complete' ? 'Completing...' : 'Complete Stay'}
              </button>
              <button
                onClick={() => handleAction(() => disputeWithWallet('Disputed by tenant'))}
                disabled={isLoading || isWalletRequired || blockedByAccountSwitch}
                className="rounded-lg bg-yellow-600 px-4 py-2 text-white transition-colors hover:bg-yellow-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isLoading && pendingAction === 'dispute' ? 'Disputing...' : 'Dispute'}
              </button>
            </>
          )}

          {(booking.status === 'pending' || booking.status === 'confirmed') && (
            <button
              onClick={() => handleAction(cancelWithWallet)}
              disabled={isLoading || isWalletRequired || blockedByAccountSwitch}
              className="rounded-lg bg-red-600 px-4 py-2 text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isLoading && pendingAction === 'cancel' ? 'Cancelling...' : 'Cancel Booking'}
            </button>
          )}
        </div>

        {isWalletRequired && (
          <p className="text-sm text-yellow-600" role="status">
            Please connect your wallet to perform booking actions
          </p>
        )}
      </div>
    </WalletRequiredGuard>
  );
}
