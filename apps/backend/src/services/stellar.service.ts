/**
 * Stellar service — wraps Stellar Horizon interactions for payment transactions.
 *
 * Responsibilities:
 * - Submit signed XDR transactions to Stellar testnet/mainnet
 * - Poll Horizon for confirmation with timeout
 * - Retry logic with double-spend protection (check existing tx hash first)
 *
 * All blockchain calls are isolated here. Controllers/routes never call
 * Horizon directly.
 *
 * OAuth/passkey design note:
 * When OAuth or passkey support is added, authentication still produces a JWT
 * with { userId, role }. This service only operates on signed XDR from the
 * wallet layer and is fully independent of the auth mechanism.
 */

import { Horizon } from '@stellar/stellar-sdk';
import {
  getHorizonUrl,
  getStellarNetwork,
  parseAndValidateXdr,
} from '@/blockchain/network.js';
import {
  updatePaymentStatus,
  getPaymentStatus,
  persistPaymentStellarContext,
} from './payment.service.js';
import {
  pollUntilConfirmed,
  horizonFetchTransaction,
  horizonFetchLedgerHead,
} from './transactionConfirmation.service.js';

function getHorizonServer(): Horizon.Server {
  return new Horizon.Server(getHorizonUrl());
}

export interface SubmitResult {
  txHash: string;
}

/**
 * Submit a signed transaction XDR to Stellar Horizon.
 * Returns the transaction hash on success. Throws on failure.
 * Rejects XDR signed for the wrong network before broadcast.
 */
export async function submitTransaction(signedXdr: string): Promise<SubmitResult> {
  const tx = parseAndValidateXdr(signedXdr);
  const server = getHorizonServer();
  const response = await server.submitTransaction(tx);
  return { txHash: response.hash };
}

export type ConfirmTransactionResult = 'confirmed' | 'timed_out' | 'failed';

/**
 * Poll Horizon until the transaction is confirmed, failed on-chain, or the
 * bounded poll window expires (handed off to background reconciliation).
 */
export async function confirmTransaction(
  paymentId: string,
  txHash: string,
): Promise<ConfirmTransactionResult> {
  const network = getStellarNetwork();
  const server = getHorizonServer();

  await persistPaymentStellarContext(paymentId, {
    stellar_tx_hash: txHash,
    stellar_network: network,
    confirmation_status: 'pending',
  });

  const result = await pollUntilConfirmed(txHash, {
    fetchTransaction: horizonFetchTransaction(server),
    fetchLedgerHead: horizonFetchLedgerHead(server),
  });

  if (result.status === 'confirmed') {
    await updatePaymentStatus(paymentId, txHash, 'confirmed', {
      stellarNetwork: network,
      confirmationStatus: 'confirmed',
    });
    return 'confirmed';
  }

  if (result.status === 'failed') {
    await updatePaymentStatus(paymentId, txHash, 'failed', {
      stellarNetwork: network,
      confirmationStatus: 'failed',
    });
    return 'failed';
  }

  // Deadline without confirmation — not a payment failure; reconciliation continues.
  await updatePaymentStatus(paymentId, txHash, 'timed_out', {
    stellarNetwork: network,
    confirmationStatus: 'awaiting_reconciliation',
  });
  return 'timed_out';
}

/**
 * Retry a failed or timed-out payment.
 * Double-spend protection: if a txHash already exists, re-polls it instead
 * of submitting a new transaction.
 */
export async function retryTransaction(
  paymentId: string,
  signedXdr?: string,
): Promise<{ txHash: string; status: ConfirmTransactionResult }> {
  const payment = await getPaymentStatus(paymentId);
  if (!payment) throw new Error('Payment not found');

  if (!['failed', 'timed_out'].includes(payment.status)) {
    throw new Error(`Cannot retry payment in status: ${payment.status}`);
  }

  let txHash: string;

  if (payment.stellar_tx_hash) {
    // Already submitted — re-poll to avoid double-spend
    txHash = payment.stellar_tx_hash;
  } else {
    if (!signedXdr) throw new Error('signedXdr required for payments that were never submitted');
    const result = await submitTransaction(signedXdr);
    txHash = result.txHash;
    await updatePaymentStatus(paymentId, txHash, 'submitted');
  }

  const status = await confirmTransaction(paymentId, txHash);
  return { txHash, status };
}
