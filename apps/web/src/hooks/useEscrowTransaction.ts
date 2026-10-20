'use client';

import { useCallback, useState } from 'react';
import * as StellarSdk from '@stellar/stellar-sdk';
import { getNetworkPassphrase, STELLAR_NETWORKS, getExplorerUrl } from '@/lib/network-utils';
import { signWithFreighter, FreighterError } from '@/lib/freighter-utils';
import {
  buildEscrowFundingTransaction,
  buildEscrowReleaseTransaction,
} from '@/lib/stellar-transactions';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
const DEFAULT_SIGNING_TIMEOUT = 60000; // 60 seconds

export type EscrowTxType = 'fund' | 'release';
export type EscrowTxStatus =
  | 'idle'
  | 'waiting_signature'
  | 'submitting'
  | 'pending_verification'
  | 'success'
  | 'error'
  | 'timeout'
  | 'reconciliation_failed';

export type ReconciliationErrorCategory = 'transient' | 'permanent' | 'manual_review';

export interface EscrowTransactionResult {
  txHash: string;
  explorerUrl: string;
  reconciliationStatus?: 'pending_verification' | 'verified' | 'failed';
  attemptId?: string;
  errorCategory?: ReconciliationErrorCategory;
  nextRetryAt?: string | null;
}

interface ReconciliationResponse {
  status?: string;
  reconciliationStatus?: string;
  attemptId?: string;
  errorCategory?: ReconciliationErrorCategory;
  nextRetryAt?: string | null;
  message?: string;
}

const MANUAL_REVIEW_MESSAGE =
  'Your payment was submitted but escrow verification needs a manual review. ' +
  'Funds remain locked until verification completes. Our team has been notified — ' +
  'please do not retry payment.';

const TRANSIENT_FAILURE_MESSAGE =
  'Your payment was submitted but escrow verification is temporarily delayed. ' +
  'Funds remain locked until verification completes. You can safely retry verification.';

const PERMANENT_FAILURE_MESSAGE =
  'Your payment was submitted but escrow verification failed. ' +
  'Funds remain locked until this is resolved. Please contact support.';

async function parseReconciliationResponse(res: Response): Promise<ReconciliationResponse> {
  try {
    return (await res.json()) as ReconciliationResponse;
  } catch {
    return {};
  }
}

async function submitXdrToHorizon(xdr: string, network: 'testnet' | 'mainnet') {
  const passphrase = getNetworkPassphrase(network);
  const tx = StellarSdk.Transaction.fromXDR(xdr, passphrase);
  const client = new StellarSdk.Horizon.Server(
    network === 'mainnet'
      ? STELLAR_NETWORKS.mainnet.horizonUrl
      : STELLAR_NETWORKS.testnet.horizonUrl,
  );

  const result = await client.submitTransaction(tx);
  return result.hash;
}

export function useEscrowTransaction(network: 'testnet' | 'mainnet' = 'testnet') {
  const [status, setStatus] = useState<EscrowTxStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [canRetry, setCanRetry] = useState(false);

  const submit = useCallback(
    async (params: {
      type: EscrowTxType;
      escrowId: string;
      amount?: string | number;
      tenantPublicKey?: string;
      ownerPublicKey?: string;
      signingTimeout?: number;
    }): Promise<EscrowTransactionResult> => {
      const {
        type,
        escrowId,
        amount,
        tenantPublicKey,
        ownerPublicKey,
        signingTimeout = DEFAULT_SIGNING_TIMEOUT,
      } = params;

      setStatus('idle');
      setError(null);
      setCanRetry(false);

      try {
        const { xdr } =
          type === 'fund'
            ? buildEscrowFundingTransaction(
                escrowId,
                amount ?? '0',
                tenantPublicKey ?? '',
                network,
              )
            : buildEscrowReleaseTransaction(
                escrowId,
                ownerPublicKey ?? '',
                network,
              );

        // Sign via Freighter with timeout
        setStatus('waiting_signature');
        const signedXdr = await signWithFreighter(xdr, network, { timeout: signingTimeout });

        // Submit to Stellar network
        setStatus('submitting');
        const txHash = await submitXdrToHorizon(signedXdr, network);

        // Notify backend and await reconciliation outcome
        setStatus('pending_verification');
        const endpoint =
          type === 'fund'
            ? `${API_URL}/api/v1/bookings/escrow/${escrowId}/fund`
            : `${API_URL}/api/v1/bookings/escrow/${escrowId}/release`;
        const body =
          type === 'fund'
            ? { amount: String(amount ?? '0'), txHash }
            : { reason: 'Release signed by owner', txHash };

        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        const reconciliation = await parseReconciliationResponse(response);
        const reconciliationStatus =
          reconciliation.reconciliationStatus ?? reconciliation.status;

        if (!response.ok || reconciliationStatus === 'failed' || reconciliationStatus === 'manual_review') {
          const errorCategory: ReconciliationErrorCategory =
            reconciliation.errorCategory ??
            (reconciliationStatus === 'manual_review' ? 'manual_review' : 'permanent');

          setStatus('reconciliation_failed');
          setError(
            errorCategory === 'manual_review'
              ? MANUAL_REVIEW_MESSAGE
              : errorCategory === 'transient'
                ? TRANSIENT_FAILURE_MESSAGE
                : PERMANENT_FAILURE_MESSAGE,
          );
          // Only transient failures are safe to retry from the client.
          setCanRetry(errorCategory === 'transient');

          return {
            txHash,
            explorerUrl: getExplorerUrl(txHash, network),
            reconciliationStatus: 'failed',
            attemptId: reconciliation.attemptId,
            errorCategory,
            nextRetryAt: reconciliation.nextRetryAt ?? null,
          };
        }

        if (reconciliationStatus === 'pending_verification') {
          setStatus('pending_verification');
          setError(null);
          setCanRetry(false);
          return {
            txHash,
            explorerUrl: getExplorerUrl(txHash, network),
            reconciliationStatus: 'pending_verification',
            attemptId: reconciliation.attemptId,
            nextRetryAt: reconciliation.nextRetryAt ?? null,
          };
        }

        setStatus('success');
        return {
          txHash,
          explorerUrl: getExplorerUrl(txHash, network),
          reconciliationStatus: 'verified',
          attemptId: reconciliation.attemptId,
        };
      } catch (err) {
        const isFreighterError = err instanceof FreighterError;
        
        if (isFreighterError && err.code === 'TIMEOUT') {
          setStatus('timeout');
          setError('Signing request timed out. Please check your wallet and try again.');
          setCanRetry(true);
        } else if (isFreighterError && err.code === 'USER_REJECTED') {
          setStatus('error');
          setError('Transaction was rejected. You can try again when ready.');
          setCanRetry(true);
        } else if (isFreighterError && err.code === 'NETWORK_MISMATCH') {
          setStatus('error');
          setError(err.message);
          setCanRetry(false);
        } else {
          setStatus('error');
          setError(err instanceof Error ? err.message : 'Failed to submit transaction');
          setCanRetry(true);
        }

        throw err;
      }
    },
    [network],
  );

  const reset = useCallback(() => {
    setStatus('idle');
    setError(null);
    setCanRetry(false);
  }, []);

  return { 
    submit, 
    status, 
    error, 
    canRetry,
    reset,
    isSubmitting: status === 'waiting_signature' || status === 'submitting',
    isPendingVerification: status === 'pending_verification',
    isReconciliationFailed: status === 'reconciliation_failed',
  };
}

