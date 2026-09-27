'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { WalletConnectButton } from './WalletConnectButton';
import { WalletErrorDisplay } from './WalletErrorDisplay';
import { useWalletContext } from '@/context/WalletContext';
import {
  getUnsupportedEnvironmentMessage,
  isUnsupportedWalletEnvironment,
} from '@/lib/freighter-utils';

interface WalletOnboardingModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConnected?: (address: string) => void;
  requiredNetwork?: 'testnet' | 'mainnet';
}

/**
 * Wallet onboarding modal with focus trap, status announcements, and
 * unsupported-environment messaging (#626).
 */
export function WalletOnboardingModal({
  isOpen,
  onClose,
  onConnected,
  requiredNetwork = 'testnet',
}: WalletOnboardingModalProps) {
  const [step, setStep] = useState<'intro' | 'connect' | 'connected'>('intro');
  const [isClosing, setIsClosing] = useState(false);
  const [statusMessage, setStatusMessage] = useState('Wallet connection dialog opened');
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const { state } = useWalletContext();

  const unsupported =
    state.unsupportedEnvironment || isUnsupportedWalletEnvironment();
  const unsupportedMessage =
    state.unsupportedMessage || getUnsupportedEnvironmentMessage();

  const handleClose = useCallback(() => {
    setIsClosing(true);
    setStatusMessage('Wallet connection dialog closed');
    setTimeout(() => {
      onClose();
      setIsClosing(false);
      previouslyFocused.current?.focus();
    }, 300);
  }, [onClose]);

  useEffect(() => {
    if (!isOpen) return;

    setStep('intro');
    setIsClosing(false);
    setStatusMessage('Wallet connection dialog opened');
    previouslyFocused.current = document.activeElement as HTMLElement | null;

    const panel = panelRef.current;
    const focusable = panel?.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    focusable?.[0]?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleClose();
        return;
      }
      if (e.key !== 'Tab' || !panel) return;

      const nodes = panel.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen, handleClose]);

  useEffect(() => {
    if (step === 'connect') {
      setStatusMessage(
        state.isLoading
          ? 'Connecting to Freighter wallet'
          : state.error
            ? `Wallet error: ${state.error}`
            : 'Ready to connect Freighter wallet',
      );
    }
    if (step === 'connected') {
      setStatusMessage('Wallet connected successfully');
    }
  }, [step, state.isLoading, state.error]);

  const handleConnect = (address: string) => {
    setStep('connected');
    setStatusMessage(`Wallet connected: ${address.slice(0, 6)}…${address.slice(-4)}`);
    onConnected?.(address);
    setTimeout(() => handleClose(), 3000);
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto"
      aria-labelledby="modal-title"
      role="dialog"
      aria-modal="true"
      data-testid="wallet-onboarding-modal"
    >
      <div
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="wallet-modal-status"
      >
        {statusMessage}
      </div>

      <div className="flex min-h-screen items-end justify-center px-4 pb-20 pt-4 text-center sm:block sm:p-0">
        <div
          className={`fixed inset-0 bg-gray-500 bg-opacity-75 transition-opacity ${isClosing ? 'opacity-0' : 'opacity-100'}`}
          aria-hidden="true"
          onClick={handleClose}
        />

        <div
          ref={panelRef}
          className={`inline-block transform overflow-hidden rounded-lg bg-white text-left align-bottom shadow-xl transition-all sm:my-8 sm:w-full sm:max-w-lg sm:align-middle ${
            isClosing ? 'scale-95 opacity-0' : 'scale-100 opacity-100'
          }`}
        >
          <div className="bg-white px-4 pb-4 pt-5 sm:p-6 sm:pb-4">
            <div className="w-full text-center sm:text-left">
              {unsupported ? (
                <div data-testid="wallet-unsupported">
                  <h3 className="text-lg font-medium leading-6 text-gray-900" id="modal-title">
                    Wallet not supported in this browser
                  </h3>
                  <p className="mt-3 text-sm text-gray-600">{unsupportedMessage}</p>
                  <ul className="mt-3 list-disc space-y-1 pl-5 text-left text-sm text-gray-600">
                    <li>Desktop: Chrome / Firefox / Brave + Freighter extension</li>
                    <li>Mobile: Freighter-supported Safari/Chrome handoff only</li>
                    <li>In-app browsers (Instagram, Facebook, LINE) are not supported</li>
                  </ul>
                  <div className="mt-5 sm:flex sm:flex-row-reverse">
                    <a
                      href="https://www.freighter.app"
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex w-full justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 sm:ml-3 sm:w-auto"
                    >
                      Freighter help
                    </a>
                    <button
                      type="button"
                      onClick={handleClose}
                      className="mt-3 inline-flex w-full justify-center rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 sm:mt-0 sm:w-auto"
                    >
                      Close
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {step === 'intro' && (
                    <div>
                      <h3 className="text-lg font-medium leading-6 text-gray-900" id="modal-title">
                        Connect Your Stellar Wallet
                      </h3>
                      <p className="mt-2 text-sm text-gray-500">
                        Rentars uses Stellar for escrow payments and bookings. Freighter must be on{' '}
                        <strong>{requiredNetwork}</strong>.
                      </p>
                      <div className="mt-5 sm:flex sm:flex-row-reverse">
                        <button
                          type="button"
                          onClick={() => setStep('connect')}
                          className="inline-flex w-full justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 sm:ml-3 sm:w-auto"
                        >
                          Connect Wallet
                        </button>
                        <button
                          type="button"
                          onClick={handleClose}
                          className="mt-3 inline-flex w-full justify-center rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 sm:mt-0 sm:w-auto"
                        >
                          Skip for now
                        </button>
                      </div>
                    </div>
                  )}

                  {step === 'connect' && (
                    <div>
                      <h3 className="text-lg font-medium leading-6 text-gray-900" id="modal-title">
                        Connect Your Wallet
                      </h3>
                      <p className="sr-only" role="status" aria-live="polite">
                        {state.isLoading ? 'Loading wallet status' : 'Awaiting Freighter response'}
                      </p>
                      <div className="mt-4">
                        <WalletConnectButton onConnect={handleConnect} className="w-full justify-center" />
                        <WalletErrorDisplay className="mt-4" />
                      </div>
                      <button
                        type="button"
                        onClick={() => setStep('intro')}
                        className="mt-4 text-sm text-gray-500 hover:text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        ← Back
                      </button>
                    </div>
                  )}

                  {step === 'connected' && (
                    <div>
                      <h3 className="text-lg font-medium leading-6 text-gray-900" id="modal-title">
                        Wallet Connected
                      </h3>
                      <p className="mt-2 text-sm text-gray-500">
                        Your Stellar wallet is connected. You can book properties and manage escrow.
                      </p>
                      <button
                        type="button"
                        onClick={handleClose}
                        className="mt-5 inline-flex w-full justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 sm:w-auto"
                      >
                        Get Started
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
