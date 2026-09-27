'use client';

import { useState, useRef, useEffect } from 'react';
import { useWalletContext } from '@/context/WalletContext';
import { FreighterError } from '@/lib/freighter-utils';
import { getExpectedNetwork } from '@/lib/network-utils';

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
    const dropdownRef = useRef<HTMLDivElement>(null);

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

    const handleConnect = async () => {
        if (isConnecting) return;

        setIsConnecting(true);
        try {
            await connect();
            if (state.address && onConnect) {
                onConnect(state.address);
            }
        } catch (error) {
            if (error instanceof FreighterError) {
                // Error is already handled in the hook
                if (onError) onError(error);
            } else if (onError) {
                onError(error as Error);
            }
        } finally {
            setIsConnecting(false);
        }
    };

    const handleDisconnect = () => {
        disconnect();
        setIsDropdownOpen(false);
        if (onDisconnect) onDisconnect();
    };

    // Format address for display (e.g., "GABCD...12345")
    const formatAddress = (address: string) => {
        if (!address) return '';
        return `${address.slice(0, 6)}...${address.slice(-6)}`;
    };

    // Determine button state
    const getButtonState = () => {
        if (!isReady || state.isLoading) {
            return { text: 'Loading...', disabled: true, variant: 'secondary' };
        }
        if (isConnecting) {
            return { text: 'Connecting...', disabled: true, variant: 'secondary' };
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
    const expectedNetwork = getExpectedNetwork();

    return (
        <div className={`relative ${className}`} ref={dropdownRef}>
            <button
                onClick={state.isConnected ? () => setIsDropdownOpen(!isDropdownOpen) : handleConnect}
                disabled={buttonState.disabled}
                className={`
          px-4 py-2 rounded-lg font-medium transition-all duration-200
          flex items-center gap-2 whitespace-nowrap
          ${buttonState.variant === 'primary' && 'bg-blue-600 hover:bg-blue-700 text-white'}
          ${buttonState.variant === 'secondary' && 'bg-gray-200 text-gray-600 cursor-wait'}
          ${buttonState.variant === 'error' && 'bg-red-100 text-red-700 border border-red-300 hover:bg-red-200'}
          ${buttonState.variant === 'connected' && 'bg-green-100 text-green-700 border border-green-300 hover:bg-green-200'}
          ${buttonState.disabled && 'opacity-50 cursor-not-allowed'}
        `}
            >
                {/* Status indicator */}
                {state.isConnected && (
                    <span className="relative flex h-3 w-3">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-3 w-3 bg-green-500"></span>
          </span>
                )}

                {state.isConnected && state.networkMismatch && (
                    <span className="relative flex h-3 w-3">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-yellow-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-3 w-3 bg-yellow-500"></span>
          </span>
                )}

                <span>{buttonState.text}</span>

                {/* Dropdown arrow */}
                {state.isConnected && (
                    <svg
                        className={`w-4 h-4 transition-transform ${isDropdownOpen ? 'rotate-180' : ''}`}
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                    >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                )}
            </button>

            {/* Dropdown menu */}
            {isDropdownOpen && state.isConnected && (
                <div className="absolute right-0 mt-2 w-72 bg-white rounded-lg shadow-lg border border-gray-200 z-50 overflow-hidden">
                    <div className="p-4 border-b border-gray-100">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center">
                                <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                                </svg>
                            </div>
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-gray-900 truncate">{state.address}</p>
                                <p className="text-xs text-gray-500">
                                    Wallet: <span className="font-medium capitalize">{state.network}</span>
                                    {' · '}
                                    App: <span className="font-medium capitalize">{expectedNetwork}</span>
                                </p>
                            </div>
                        </div>
                    </div>

                    <div className="p-2">
                        {/* Network status */}
                        {state.networkMismatch && (
                            <div className="px-3 py-2 mb-2 bg-yellow-50 border border-yellow-200 rounded-lg">
                                <p className="text-xs text-yellow-800">
                                    ⚠️ Network mismatch. Switch Freighter to {expectedNetwork} to continue.
                                </p>
                            </div>
                        )}

                        {/* Wallet info */}
                        <div className="px-3 py-2">
                            <p className="text-xs text-gray-500">Connected Address</p>
                            <p className="text-xs font-mono text-gray-700 break-all">{state.address}</p>
                        </div>

                        {/* Actions */}
                        <div className="border-t border-gray-100 mt-2 pt-2">
                            <button
                                onClick={handleDisconnect}
                                className="w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                            >
                                Disconnect Wallet
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}