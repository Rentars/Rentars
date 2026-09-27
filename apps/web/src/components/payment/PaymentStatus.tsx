'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
const POLL_INTERVAL_MS = 3_000;
const DELAYED_CONFIRMATION_THRESHOLD_MS = 15_000;

export type PaymentStatusValue =
  | 'idle'
  | 'awaiting_wallet_approval'
  | 'submitted'
  | 'confirmed'
  | 'failed'
  | 'timed_out'
  | 'awaiting_reconciliation';

interface PaymentStatusProps {
  /** Payment ID returned from /api/v1/payments/submit */
  paymentId?: string;
  /** Called when user explicitly asks to retry */
  onRetry?: () => void;
  /** Called when user cancels after failure */
  onCancel?: () => void;
  /** Controlled status override (e.g. 'awaiting_wallet_approval' before submitting) */
  status?: PaymentStatusValue;
  /** TX hash if already known */
  txHash?: string;
}

const STATE_CONFIG: Record<
  PaymentStatusValue,
  { icon: string; title: string; description: string; color: string }
> = {
  idle: {
    icon: '💳',
    title: 'Ready to Pay',
    description: 'Confirm your booking to proceed with payment.',
    color: 'text-gray-600',
  },
  awaiting_wallet_approval: {
    icon: '🔐',
    title: 'Waiting for Wallet Approval',
    description: 'Please approve the transaction in your Freighter wallet.',
    color: 'text-blue-600',
  },
  submitted: {
    icon: '⏳',
    title: 'Payment Submitted',
    description: 'Your payment is on the Stellar network and awaiting ledger confirmation.',
    color: 'text-yellow-600',
  },
  confirmed: {
    icon: '✅',
    title: 'Payment Confirmed',
    description: 'Your USDC payment has been confirmed on Stellar.',
    color: 'text-green-600',
  },
  failed: {
    icon: '❌',
    title: 'Payment Failed',
    description: 'Your payment could not be processed. Please try again.',
    color: 'text-red-600',
  },
  timed_out: {
    icon: '⏱️',
    title: 'Confirmation Delayed',
    description: 'We are still verifying your payment on Stellar. This is not a failure.',
    color: 'text-amber-600',
  },
  awaiting_reconciliation: {
    icon: '🔄',
    title: 'Pending Reconciliation',
    description:
      'Your payment was submitted successfully. Background reconciliation is still confirming it on Stellar.',
    color: 'text-amber-600',
  },
};

function mapApiStatus(
  status: string,
  confirmationStatus?: string,
): PaymentStatusValue {
  if (status === 'timed_out' && confirmationStatus === 'awaiting_reconciliation') {
    return 'awaiting_reconciliation';
  }
  if (status === 'submitted') {
    return 'submitted';
  }
  if (status === 'confirmed') {
    return 'confirmed';
  }
  if (status === 'failed') {
    return 'failed';
  }
  if (status === 'timed_out') {
    return 'timed_out';
  }
  return 'idle';
}

/**
 * PaymentStatus — displays the current state of a USDC payment with polling.
 *
 * Distinguishes submitted (inline poll) vs confirmed vs pending reconciliation
 * (poll window expired but tx may still land on ledger).
 */
export function PaymentStatus({
  paymentId,
  onRetry,
  onCancel,
  status: controlledStatus,
  txHash: initialTxHash,
}: PaymentStatusProps) {
  const [internalStatus, setInternalStatus] = useState<PaymentStatusValue>('idle');
  const [txHash, setTxHash] = useState<string | undefined>(initialTxHash);
  const [isDelayed, setIsDelayed] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const delayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const status = controlledStatus ?? internalStatus;
  const config = STATE_CONFIG[status];

  const shouldPoll =
    Boolean(paymentId) &&
    (status === 'submitted' ||
      status === 'awaiting_reconciliation' ||
      status === 'timed_out');

  // Poll for status updates while submitted or awaiting reconciliation
  useEffect(() => {
    if (!shouldPoll) {
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }

    const token = localStorage.getItem('token');

    const poll = async () => {
      try {
        const res = await fetch(`${API_URL}/api/v1/payments/${paymentId}/status`, {
          headers: { Authorization: `Bearer ${token ?? ''}` },
        });
        if (!res.ok) return;
        const json = (await res.json()) as {
          status: string;
          confirmationStatus?: string;
          txHash?: string;
        };
        if (json.txHash) setTxHash(json.txHash);
        const next = mapApiStatus(json.status, json.confirmationStatus);
        if (next === 'confirmed' || next === 'failed') {
          setInternalStatus(next);
          if (pollRef.current) clearInterval(pollRef.current);
          if (delayTimerRef.current) clearTimeout(delayTimerRef.current);
        } else if (next !== status) {
          setInternalStatus(next);
        }
      } catch {
        // network error — keep polling
      }
    };

    pollRef.current = setInterval(poll, POLL_INTERVAL_MS);
    poll();

    if (status === 'submitted') {
      delayTimerRef.current = setTimeout(
        () => setIsDelayed(true),
        DELAYED_CONFIRMATION_THRESHOLD_MS,
      );
    }

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (delayTimerRef.current) clearTimeout(delayTimerRef.current);
      setIsDelayed(false);
    };
  }, [paymentId, shouldPoll, status]);

  const showRetry = status === 'failed';
  const showCancel = status === 'failed';

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={`Payment status: ${config.title}`}
      className="flex flex-col items-center gap-4 rounded-xl border border-gray-200 bg-white p-8 text-center shadow-sm"
    >
      {/* Status icon */}
      <span className="text-5xl" aria-hidden="true">
        {config.icon}
      </span>

      {/* Status title */}
      <h2 className={`text-xl font-semibold ${config.color}`}>{config.title}</h2>

      {/* Description */}
      <p className="max-w-sm text-sm text-gray-600">{config.description}</p>

      {/* Delayed confirmation banner */}
      {status === 'submitted' && isDelayed && (
        <div
          role="alert"
          className="rounded-md bg-yellow-50 border border-yellow-200 px-4 py-3 text-sm text-yellow-800 max-w-sm"
        >
          Your payment is being confirmed on the Stellar network. This may take up to 60 seconds.
        </div>
      )}

      {/* Spinner for in-progress states */}
      {(status === 'awaiting_wallet_approval' ||
        status === 'submitted' ||
        status === 'awaiting_reconciliation' ||
        status === 'timed_out') && (
        <div
          aria-hidden="true"
          className="h-6 w-6 animate-spin rounded-full border-2 border-blue-500 border-t-transparent"
        />
      )}

      {/* TX hash link */}
      {txHash && status === 'confirmed' && (
        <a
          href={
            process.env.NEXT_PUBLIC_STELLAR_NETWORK === 'mainnet'
              ? `https://stellar.expert/explorer/public/tx/${txHash}`
              : `https://stellar.expert/explorer/testnet/tx/${txHash}`
          }
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-blue-600 hover:underline font-mono"
        >
          View on Stellar Explorer ↗
        </a>
      )}

      {/* Action buttons */}
      {(showRetry || showCancel) && (
        <div className="flex gap-3">
          {showRetry && onRetry && (
            <Button onClick={onRetry} variant="default">
              Retry Payment
            </Button>
          )}
          {showCancel && onCancel && (
            <Button onClick={onCancel} variant="outline">
              Cancel
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
