/**
 * Backend client for the Review Soroban contract.
 *
 * ABI reference: apps/contracts/review_abi.json
 *
 * This module wraps the @stellar/stellar-sdk contract invocation API and
 * provides typed methods that mirror every function in the ABI.
 */

import {
  Contract,
  Keypair,
  Networks,
  rpc,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import type {
  Review,
  ReviewCommitment,
  SubmitReviewCommitmentParams,
  SubmitReviewCommitmentResult,
  SubmitReviewParams,
  TransactionConfirmation,
} from './types.js';

// ─── ABI metadata (sourced from review_abi.json) ─────────────────────────────
const ABI_VERSION = '0.1.0';
const CONTRACT_NAME = 'review-contract';

// ─── Client ──────────────────────────────────────────────────────────────────

export class ReviewClient {
  private readonly contract: Contract;
  private readonly server: rpc.Server;
  private readonly networkPassphrase: string;

  constructor(
    contractId: string,
    rpcUrl: string,
    networkPassphrase: string = Networks.TESTNET,
  ) {
    this.contract = new Contract(contractId);
    this.server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });
    this.networkPassphrase = networkPassphrase;
  }

  // ── Read-only queries ─────────────────────────────────────────────────────

  /**
   * Retrieve a review by its global ID.
   *
   * ABI: get_review(id: u64) -> Review
   */
  async getReview(id: bigint): Promise<Review> {
    const result = await this.simulateReadOnly('get_review', [
      nativeToScVal(id, { type: 'u64' }),
    ]);
    return scValToNative(result) as Review;
  }

  /**
   * Return all review IDs submitted for a given reviewee.
   *
   * ABI: get_reviews_for_user(reviewee: Address) -> Vec<u64>
   */
  async getReviewsForUser(reviewee: string): Promise<bigint[]> {
    const result = await this.simulateReadOnly('get_reviews_for_user', [
      nativeToScVal(reviewee, { type: 'address' }),
    ]);
    const native = scValToNative(result) as (number | string)[];
    return native.map((v) => BigInt(v));
  }

  /**
   * Return the average rating for a reviewee scaled by 100.
   *
   * ABI: get_reputation(reviewee: Address) -> u32
   *
   * Returns 0 if no reviews exist. Divide by 100 to get the decimal average
   * (e.g. 450 → 4.50 stars).
   */
  async getReputation(reviewee: string): Promise<number> {
    const result = await this.simulateReadOnly('get_reputation', [
      nativeToScVal(reviewee, { type: 'address' }),
    ]);
    return scValToNative(result) as number;
  }

  /**
   * Return the total number of reviews ever submitted.
   *
   * ABI: review_count() -> u64
   */
  async reviewCount(): Promise<bigint> {
    const result = await this.simulateReadOnly('review_count', []);
    return BigInt(scValToNative(result) as number | string);
  }

  /**
   * Look up an on-chain review reference by its commitment hash.
   *
   * ABI: get_review_by_commitment(commitment: BytesN<32>) -> Option<ReviewCommitment>
   *
   * Returns `null` when no review has been anchored for the given commitment.
   * Only the commitment and non-sensitive identifiers are ever stored on-chain;
   * the raw review content is never published.
   */
  async getReviewByCommitment(commitment: string): Promise<ReviewCommitment | null> {
    const commitmentBytes = this.parseCommitment(commitment);
    const result = await this.simulateReadOnly('get_review_by_commitment', [
      nativeToScVal(commitmentBytes, { type: 'bytes' }),
    ]);

    const native = scValToNative(result);
    if (native === null || native === undefined) {
      return null;
    }

    return native as ReviewCommitment;
  }

  // ── State-changing operations ─────────────────────────────────────────────

  /**
   * Build the XDR operation for submit_review.
   *
   * ABI: submit_review(reviewer, reviewee, rating, comment) -> u64
   *
   * The caller is responsible for wrapping in a transaction, signing with
   * the reviewer's keypair, and submitting via the Stellar network.
   *
   * Constraints enforced on-chain:
   *   - rating must be 1–5 inclusive
   *   - reviewer may only review each reviewee once
   */
  buildSubmitReview(params: SubmitReviewParams): xdr.Operation {
    if (params.rating < 1 || params.rating > 5) {
      throw new RangeError(
        `Rating must be between 1 and 5 inclusive, got ${params.rating}`,
      );
    }

    return this.contract.call(
      'submit_review',
      nativeToScVal(params.reviewer, { type: 'address' }),
      nativeToScVal(params.reviewee, { type: 'address' }),
      nativeToScVal(params.rating, { type: 'u32' }),
      nativeToScVal(params.comment, { type: 'string' }),
    );
  }

  /**
   * Build the XDR operation for submit_review_commitment.
   *
   * ABI: submit_review_commitment(
   *   reviewer: Address,
   *   commitment: BytesN<32>,
   *   booking_id: String,
   *   property_id: String,
   *   nonce: BytesN<32>,
   * ) -> u64
   *
   * Only the privacy-safe commitment and non-sensitive identifiers are passed
   * to the contract. Raw review text, ratings and personal data must never be
   * included here.
   */
  buildSubmitReviewCommitment(
    params: SubmitReviewCommitmentParams,
  ): xdr.Operation {
    return this.contract.call(
      'submit_review_commitment',
      nativeToScVal(params.reviewer, { type: 'address' }),
      nativeToScVal(this.parseCommitment(params.commitment), { type: 'bytes' }),
      nativeToScVal(params.bookingId, { type: 'string' }),
      nativeToScVal(params.propertyId, { type: 'string' }),
      nativeToScVal(this.parseCommitment(params.nonce), { type: 'bytes' }),
    );
  }

  /**
   * Submit a review commitment on-chain and wait for confirmation.
   *
   * The caller supplies a signed transaction envelope (built from
   * `buildSubmitReviewCommitment`) so that signing stays with the reviewer's
   * keypair. Returns the transaction hash, ledger and confirmation status.
   *
   * A failed or pending transaction is reported as such; it never implies the
   * off-chain review is verified.
   */
  async submitReviewCommitment(
    params: SubmitReviewCommitmentParams,
    signedEnvelopeXdr: string,
  ): Promise<SubmitReviewCommitmentResult> {
    const envelope = TransactionBuilder.fromXDR(
      signedEnvelopeXdr,
      this.networkPassphrase,
    );

    const sendResponse = await this.server.sendTransaction(envelope);
    const txHash = sendResponse.hash;

    if (sendResponse.status === 'ERROR') {
      return {
        txHash,
        ledger: null,
        status: 'failed',
        commitment: params.commitment,
      };
    }

    const confirmation = await this.waitForConfirmation(txHash);

    return {
      txHash,
      ledger: confirmation.ledger,
      status: confirmation.status,
      commitment: params.commitment,
    };
  }

  /**
   * Poll the RPC until the transaction is confirmed (SUCCESS), fails
   * (FAILED) or the polling budget is exhausted (NOT_FOUND).
   *
   * Pending transactions are never treated as confirmed.
   */
  async waitForConfirmation(
    txHash: string,
    options: { attempts?: number; intervalMs?: number } = {},
  ): Promise<TransactionConfirmation> {
    const attempts = options.attempts ?? 20;
    const intervalMs = options.intervalMs ?? 1_500;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const response = await this.server.getTransaction(txHash);

      if (response.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        return {
          txHash,
          ledger: response.ledger,
          status: 'confirmed',
        };
      }

      if (response.status === rpc.Api.GetTransactionStatus.FAILED) {
        return {
          txHash,
          ledger: response.ledger ?? null,
          status: 'failed',
        };
      }

      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }

    return { txHash, ledger: null, status: 'pending' };
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  /**
   * Normalise a hex commitment/nonce string into raw bytes.
   *
   * Accepts an optional `0x` prefix and requires exactly 32 bytes so that the
   * value maps to the contract's BytesN<32> type.
   */
  private parseCommitment(value: string): Buffer {
    const hex = value.startsWith('0x') ? value.slice(2) : value;
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new RangeError(
        'Commitment and nonce must be 32-byte hex strings (64 hex characters)',
      );
    }
    return Buffer.from(hex, 'hex');
  }

  /**
   * Simulate a read-only contract call and return the result ScVal.
   */
  private async simulateReadOnly(
    method: string,
    args: xdr.ScVal[],
  ): Promise<xdr.ScVal> {
    const sourceAccount = await this.server.getAccount(
      process.env.STELLAR_SOURCE_ACCOUNT ||
        'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
    );

    const tx = new TransactionBuilder(sourceAccount, {
      fee: '100',
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(this.contract.call(method, ...args))
      .setTimeout(30)
      .build();

    const simResult = await this.server.simulateTransaction(tx);

    if (rpc.Api.isSimulationError(simResult)) {
      throw new Error(
        `Contract simulation failed [${CONTRACT_NAME}@${ABI_VERSION}::${method}]: ${simResult.error}`,
      );
    }

    const successResult = simResult as rpc.Api.SimulateTransactionSuccessResponse;
    if (!successResult.result?.retval) {
      throw new Error(`No return value from ${method}`);
    }

    return successResult.result.retval;
  }
}
