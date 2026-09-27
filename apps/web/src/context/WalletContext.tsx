'use client';

import { createContext, useContext, ReactNode, useEffect } from 'react';
import { useWallet, UseWalletReturn } from '@/hooks/useWallet';

interface WalletContextType extends UseWalletReturn {
  isReady: boolean;
}

const WalletContext = createContext<WalletContextType | undefined>(undefined);

export function WalletProvider({ children }: { children: ReactNode }) {
  const wallet = useWallet();
  const isReady = !wallet.state.isLoading;

  useEffect(() => {
    const handleNetworkChange = () => {
      wallet.checkStatus();
    };

    window.addEventListener('stellar-network-change', handleNetworkChange);
    return () => window.removeEventListener('stellar-network-change', handleNetworkChange);
  }, [wallet]);

  return (
    <WalletContext.Provider value={{ ...wallet, isReady }}>
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
