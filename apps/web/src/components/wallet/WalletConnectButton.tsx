'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useWalletContext } from '@/context/WalletContext';
import { FreighterError } from '@/lib/freighter-utils';

interface WalletConnectButtonProps {
    className?: string;
    onConnect?: (address: string) => void;
    onDisconnect?: () => void;
    onError?: (error: Error) => void;
}

export function WalletConnectButton({
    className = '',
    onConnect,
    onDisconnect,
    onError
}: WalletConnectButtonProps) {
    const { state, connect, disconnect, isReady } = useWalletContext();
    const [isDropdownOpen, setIsDropdownOpen] = useState(false);
    const [isConnecting, setIsConnecting] = useState(false);
    const [announcement, setAnnouncement] = useState('');
    const dropdownRef = useRef<HTMLDivElement>(null);
    const menuId = 'wallet-dropdown-menu';

    // Close dropdown when clicking outside
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsDropdownOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    // Close dropdown on Escape key
    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && isDropdownOpen) {
                setIsDropdownOpen(false);
            }
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [isDropdownOpen]);

    // Announce connection state changes to assistive technology
    useEffect(() => {
        if (state.isConnected && state.address) {
            setAnnouncement(`Wallet connected: ${state.address}`);
        } else if (!state.isConnected && !state.isLoading) {
            setAnnouncement('Wallet disconnected');
        }
    }, [state.isConnected, state.address, state.isLoading]);

    useEffect(() => {
        if (state.networkMismatch) {
            setAnnouncement(`Network mismatch. Please switch to ${state.network} in Freighter.`);
        }
    }, [state.networkMismatch, state.network]);

    useEffect(() => {
        if (state.error) {
            setAnnouncement(`Wallet error: ${state.error}`);
        }
    }, [state.error]);

    const handleConnect = useCallback(async () => {
        if (isConnecting) return;
        setIsConnecting(true);
        setAnnouncement('Connecting wallet…');
        try {
            await connect();
            if (state.address && onConnect) {
                onConnect(state.address);
            }
        } catch (error) {
            if (error instanceof FreighterError) {
                if (onError) onError(error);
            } else if (onError) {
                onError(error as Error);
            }
        } finally {
            setIsConnecting(false);
        }
    }, [connect, isConnecting, onConnect, onError, state.address]);

    const handleDisconnect = useCallback(() => {
        disconnect();
        setIsDropdownOpen(false);
        if (onDisconnect) onDisconnect();
    }, [disconnect, onDisconnect]);

    const formatAddress = (address: string) => {
        if (!address) return '';
        return `${address.slice(0, 6)}...${address.slice(-6)}`;
    };

    const getButtonState = () => {
        if (!isReady || state.isLoading) {
            return { text: 'Loading…', disabled: true, variant: 'secondary' };
        }
        if (isConnecting) {
            return { text: 'Connecting…', disabled: true, variant: 'secondary' };
        }
        if (state.isConnected && state.address) {
            return {
                text: formatAddress(state.address),
                disabled: false,
                variant: 'connected',
                isConnected: true
            };
        }
        if (state.error) {
            return { text: 'Connect Wallet', disabled: false, variant: 'error' };
        }
        return { text: 'Connect Wallet', disabled: false, variant: 'primary' };
    };

    const buttonState = getButtonState();

    const getAriaLabel = () => {
        if (!isReady || state.isLoading) return 'Wallet loading';
        if (isConnecting) return 'Connecting wallet';
        if (state.isConnected && state.address) {
            return `Wallet connected: ${state.address}. Press to open wallet menu.`;
        }
        if (state.error) return `Wallet error: ${state.error}. Press to retry connection.`;
        return 'Connect Freighter wallet';
    };

    return (
        <div className={`relative ${className}`} ref={dropdownRef}>
            {/* Live region for assistive technology announcements */}
            <div
                role="status"
                aria-live="polite"
                aria-atomic="true"
                className="sr-only"
            >
                {announcement}
            </div>

            <button
                type="button"
                onClick={state.isConnected ? () => setIsDropdownOpen(!isDropdownOpen) : handleConnect}
                disabled={buttonState.disabled}
                aria-label={getAriaLabel()}
                aria-expanded={state.isConnected ? isDropdownOpen : undefined}
                aria-haspopup={state.isConnected ? 'menu' : undefined}
                aria-controls={state.isConnected && isDropdownOpen ? menuId : undefined}
                className={`
          px-4 py-2 rounded-lg font-medium transition-all duration-200
          flex items-center gap-2 whitespace-nowrap
          focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500
          ${buttonState.variant === 'primary' && 'bg-blue-600 hover:bg-blue-700 text-white'}
          ${buttonState.variant === 'secondary' && 'bg-gray-200 text-gray-600 cursor-wait'}
          ${buttonState.variant === 'error' && 'bg-red-100 text-red-700 border border-red-300 hover:bg-red-200'}
          ${buttonState.variant === 'connected' && 'bg-green-100 text-green-700 border border-green-300 hover:bg-green-200'}
          ${buttonState.disabled && 'opacity-50 cursor-not-allowed'}
        `}
            >
                {/* Connection indicator — hidden from screen readers (label carries the info) */}
                {state.isConnected && !state.networkMismatch && (
                    <span className="relative flex h-3 w-3" aria-hidden="true">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                        <span className="relative inline-flex rounded-full h-3 w-3 bg-green-500" />
                    </span>
                )}

                {state.isConnected && state.networkMismatch && (
                    <span className="relative flex h-3 w-3" aria-hidden="true">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-yellow-400 opacity-75" />
                        <span className="relative inline-flex rounded-full h-3 w-3 bg-yellow-500" />
                    </span>
                )}

                <span>{buttonState.text}</span>

                {state.isConnected && (
                    <svg
                        className={`w-4 h-4 transition-transform ${isDropdownOpen ? 'rotate-180' : ''}`}
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                    >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                )}
            </button>

            {/* Dropdown menu */}
            {isDropdownOpen && state.isConnected && (
                <div
                    id={menuId}
                    role="menu"
                    aria-label="Wallet options"
                    className="absolute right-0 mt-2 w-72 bg-white rounded-lg shadow-lg border border-gray-200 z-50 overflow-hidden"
                >
                    <div className="p-4 border-b border-gray-100">
                        <div className="flex items-center gap-3">
                            <div
                                className="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center"
                                aria-hidden="true"
                            >
                                <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                                </svg>
                            </div>
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-gray-900 truncate">{state.address}</p>
                                <p className="text-xs text-gray-500">
                                    Network: <span className="font-medium capitalize">{state.network}</span>
                                </p>
                            </div>
                        </div>
                    </div>

                    <div className="p-2">
                        {state.networkMismatch && (
                            <div
                                role="alert"
                                className="px-3 py-2 mb-2 bg-yellow-50 border border-yellow-200 rounded-lg"
                            >
                                <p className="text-xs text-yellow-800">
                                    Network mismatch. Please switch to {state.network} in Freighter.
                                </p>
                            </div>
                        )}

                        <div className="px-3 py-2">
                            <p className="text-xs text-gray-500" id="wallet-address-label">Connected Address</p>
                            <p
                                className="text-xs font-mono text-gray-700 break-all"
                                aria-labelledby="wallet-address-label"
                            >
                                {state.address}
                            </p>
                        </div>

                        <div className="border-t border-gray-100 mt-2 pt-2">
                            <button
                                type="button"
                                role="menuitem"
                                onClick={handleDisconnect}
                                className="w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-red-50 rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-red-400"
                            >
                                Disconnect Wallet
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Unsupported environment fallback */}
            {!isReady && !state.isLoading && (
                <p
                    role="alert"
                    className="mt-2 text-xs text-gray-500"
                >
                    Wallet not available.{' '}
                    <a
                        href="https://www.freighter.app"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline text-blue-600 focus:ring-2 focus:ring-blue-500"
                    >
                        Install Freighter
                    </a>{' '}
                    to continue.
                </p>
            )}
        </div>
    );
}
