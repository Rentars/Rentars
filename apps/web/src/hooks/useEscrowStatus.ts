'use client';

import { useEffect, useState } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

export type ReconciliationState = 'ok' | 'pending' | 'mismatch' | 'manual_review';

export interface EscrowStatus {
  status: 'locked' | 'released' | 'refunded';
  amount: number;
  releaseDate?: string;
  reconciliationState: ReconciliationState;
  settlementVerified: boolean;
  lastError?: string | null;
}

export function useEscrowStatus(bookingId: string) {
  const [escrow, setEscrow] = useState<EscrowStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!bookingId) return;

    const token = localStorage.getItem('token');
    const pollInterval = setInterval(() => {
      fetch(`${API_URL}/api/bookings/${bookingId}/escrow/reconciliation`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then((r) => r.json())
        .then((data) => {
          setEscrow(data);
          setIsLoading(false);
        })
        .catch(() => setIsLoading(false));
    }, 5000);

    return () => clearInterval(pollInterval);
  }, [bookingId]);

  const reconciliationState: ReconciliationState = escrow?.reconciliationState ?? 'pending';
  const settlementVerified = escrow?.settlementVerified === true;

  // Never surface 'released' until settlement has been verified on-chain.
  const effectiveStatus: EscrowStatus['status'] | undefined =
    escrow && escrow.status === 'released' && !settlementVerified ? 'locked' : escrow?.status;

  const isPending = reconciliationState === 'pending';
  const isFailed = reconciliationState === 'mismatch' || reconciliationState === 'manual_review';

  return {
    escrow: escrow
      ? { ...escrow, status: effectiveStatus ?? escrow.status }
      : escrow,
    isLoading,
    reconciliationState,
    settlementVerified,
    lastError: escrow?.lastError ?? null,
    isPending,
    isFailed,
  };
}