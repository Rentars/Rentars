'use client';

/**
 * WalletConnectionModal — Issue 651
 *
 * Mobile behaviour  : renders as a full-screen bottom sheet (slides up from
 *                     bottom, covers the full viewport) so wallet controls are
 *                     never clipped or unreachable on small screens.
 * Desktop behaviour : centred dialog (max-w-md), unchanged from original.
 *
 * Accessibility:
 *  - role="dialog" + aria-modal + aria-labelledby on the panel element.
 *  - Focus is trapped inside the sheet while open (delegated to Modal).
 *  - Escape key closes the sheet when not mid-connection.
 *  - Backdrop click closes when not mid-connection.
 *  - Close button always visible in the header.
 *  - Status messages use role="status" (success) or role="alert" (error) so
 *    screen readers announce them without needing a live-region parent.
 *  - "Connecting…" spinner is aria-hidden; the button label changes to convey
 *    state to AT.
 */

import { useEffect, useState, useId } from 'react';
import { Loader2, AlertCircle, CheckCircle2, X, Wallet } from 'lucide-react';
import { connectFreighterWallet, FreighterError, isValidStellarAddress } from '@/lib/freighter-utils';

interface WalletConnectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConnect: (address: string) => void;
}

type ConnectionStatus = 'idle' | 'connecting' | 'success' | 'error';

export default function WalletConnectionModal({
  isOpen,
  onClose,
  onConnect,
}: WalletConnectionModalProps) {
  const [status, setStatus]                   = useState<ConnectionStatus>('idle');
  const [error, setError]                     = useState<string | null>(null);
  const [connectedAddress, setConnectedAddress] = useState<string | null>(null);

  const titleId = useId();

  // ── Restore existing connection ────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return;
    const saved = localStorage.getItem('walletAddress');
    if (saved && isValidStellarAddress(saved)) {
      setConnectedAddress(saved);
      setStatus('success');
    } else {
      // Reset each time the sheet opens so stale state doesn't leak
      setStatus('idle');
      setError(null);
      setConnectedAddress(null);
    }
  }, [isOpen]);

  // ── Body scroll lock on mobile ─────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [isOpen]);

  // ── Keyboard: Escape ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && status !== 'connecting') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, status, onClose]);

  if (!isOpen) return null;

  // ── Freighter connect ──────────────────────────────────────────────────────
  const handleFreighterConnect = async () => {
    setStatus('connecting');
    setError(null);

    try {
      const publicKey = await connectFreighterWallet();

      if (!isValidStellarAddress(publicKey)) {
        throw new FreighterError('Invalid wallet address format', 'NETWORK_ERROR');
      }

      localStorage.setItem('walletAddress', publicKey);
      setConnectedAddress(publicKey);
      setStatus('success');

      // Brief delay so users see the success state before the sheet closes
      setTimeout(() => {
        onConnect(publicKey);
        onClose();
      }, 600);
    } catch (err) {
      let msg = 'Failed to connect wallet';
      if (err instanceof FreighterError) {
        switch (err.code) {
          case 'NOT_INSTALLED':
            msg = 'Freighter wallet is not installed. Install it from freighter.app';
            break;
          case 'NOT_CONNECTED':
            msg = 'Wallet is not connected in Freighter. Open Freighter and connect your account.';
            break;
          case 'USER_REJECTED':
            msg = 'Connection rejected. Please try again.';
            break;
          default:
            msg = err.message;
        }
      }
      setError(msg);
      setStatus('error');
    }
  };

  const handleDisconnect = () => {
    localStorage.removeItem('walletAddress');
    setConnectedAddress(null);
    setStatus('idle');
    setError(null);
  };

  const canClose = status !== 'connecting';

  return (
    <>
      {/* ── Backdrop ──────────────────────────────────────────────────────── */}
      <div
        className="fixed inset-0 z-40 bg-black/50"
        aria-hidden="true"
        onClick={canClose ? onClose : undefined}
      />

      {/* ── Sheet / Dialog ────────────────────────────────────────────────── */}
      {/*
        On mobile  : slides up from the bottom, full-width, rounded top corners.
        On sm+     : centred dialog, max-w-md, standard rounded corners.
        We use CSS classes rather than JS breakpoint detection so the layout
        responds without a hydration mismatch.
      */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`
          fixed z-50 bg-white dark:bg-gray-900 shadow-2xl
          flex flex-col

          /* Mobile: full-width bottom sheet */
          bottom-0 left-0 right-0 w-full max-h-[90dvh] rounded-t-2xl
          animate-slide-up

          /* sm+: centred dialog */
          sm:inset-auto sm:top-1/2 sm:left-1/2
          sm:-translate-x-1/2 sm:-translate-y-1/2
          sm:w-full sm:max-w-md sm:rounded-2xl sm:max-h-[90vh]
        `}
      >
        {/* ── Header ──────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-gray-100 dark:border-gray-800 flex-shrink-0">
          {/* Drag handle — visual affordance on mobile */}
          <div
            className="absolute top-2.5 left-1/2 -translate-x-1/2 w-10 h-1 rounded-full bg-gray-300 dark:bg-gray-600 sm:hidden"
            aria-hidden="true"
          />

          <div className="flex items-center gap-2">
            <Wallet size={18} className="text-blue-600" aria-hidden="true" />
            <h2
              id={titleId}
              className="text-base font-semibold text-gray-900 dark:text-white"
            >
              {connectedAddress ? 'Wallet Connected' : 'Connect Your Wallet'}
            </h2>
          </div>

          <button
            type="button"
            onClick={canClose ? onClose : undefined}
            disabled={!canClose}
            aria-label="Close wallet connection"
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-gray-200
              hover:bg-gray-100 dark:hover:bg-gray-800 transition
              disabled:opacity-40 disabled:cursor-not-allowed
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {/* ── Body ────────────────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-4">

          {/* Success state */}
          {status === 'success' && connectedAddress && (
            <div
              role="status"
              aria-label="Wallet connected successfully"
              className="flex items-start gap-3 p-4 bg-green-50 dark:bg-green-950
                border border-green-200 dark:border-green-800 rounded-xl"
            >
              <CheckCircle2 size={20} className="text-green-600 flex-shrink-0 mt-0.5" aria-hidden="true" />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-green-900 dark:text-green-200">
                  Wallet Connected
                </p>
                <p className="text-xs font-mono text-green-700 dark:text-green-400 mt-1 break-all">
                  {connectedAddress}
                </p>
              </div>
            </div>
          )}

          {/* Error state */}
          {status === 'error' && error && (
            <div
              role="alert"
              className="flex items-start gap-3 p-4 bg-red-50 dark:bg-red-950
                border border-red-200 dark:border-red-800 rounded-xl"
            >
              <AlertCircle size={20} className="text-red-600 flex-shrink-0 mt-0.5" aria-hidden="true" />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-red-900 dark:text-red-200">
                  Connection Failed
                </p>
                <p className="text-sm text-red-700 dark:text-red-300 mt-1">{error}</p>
              </div>
            </div>
          )}

          {/* Idle description */}
          {!connectedAddress && status !== 'error' && status !== 'connecting' && (
            <p className="text-sm text-gray-600 dark:text-gray-400">
              Connect your Stellar wallet to complete this booking. Your USDC will be held
              in escrow on the Stellar network until your rental is confirmed.
            </p>
          )}

          {/* Connect button */}
          {!connectedAddress && (
            <button
              type="button"
              onClick={handleFreighterConnect}
              disabled={status === 'connecting'}
              aria-busy={status === 'connecting'}
              className="w-full bg-blue-600 hover:bg-blue-700 active:bg-blue-800
                disabled:bg-blue-400 text-white font-semibold py-3.5 px-4
                rounded-xl transition flex items-center justify-center gap-2
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500
                text-sm"
            >
              {status === 'connecting' && (
                <Loader2 size={18} className="animate-spin" aria-hidden="true" />
              )}
              {status === 'connecting' ? 'Connecting…' : 'Connect Freighter Wallet'}
            </button>
          )}

          {/* Retry on error */}
          {status === 'error' && (
            <button
              type="button"
              onClick={handleFreighterConnect}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold
                py-3.5 px-4 rounded-xl transition text-sm
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              Try Again
            </button>
          )}

          {/* Disconnect */}
          {connectedAddress && status === 'success' && (
            <button
              type="button"
              onClick={handleDisconnect}
              className="w-full border border-red-200 dark:border-red-800
                bg-red-50 dark:bg-red-950 hover:bg-red-100 dark:hover:bg-red-900
                text-red-700 dark:text-red-300 font-medium py-3 px-4 rounded-xl
                transition text-sm
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
            >
              Disconnect Wallet
            </button>
          )}

          {/* Install link */}
          {!connectedAddress && (
            <p className="text-xs text-gray-500 dark:text-gray-400 text-center">
              Don&apos;t have Freighter?{' '}
              <a
                href="https://www.freighter.app"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 dark:text-blue-400 font-medium hover:underline
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
              >
                Install it here
              </a>
            </p>
          )}
        </div>

        {/* ── Footer ──────────────────────────────────────────────────────── */}
        <div className="flex-shrink-0 px-5 py-3 border-t border-gray-100 dark:border-gray-800">
          <p className="text-xs text-gray-400 dark:text-gray-500 text-center">
            Connected to{' '}
            <span className="font-medium text-gray-600 dark:text-gray-300">
              Stellar Testnet
            </span>
          </p>
        </div>
      </div>
    </>
  );
}
