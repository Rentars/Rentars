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
  Networks,
  rpc,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import type { Review, SubmitReviewParams } from './types.js';

// ─── ABI metadata (sourced from review_abi.json) ─────────────────────────────
const ABI_VERSION = '0.1.0';
const CONTRACT_NAME = 'review-contract';

// ─── Pagination limits ───────────────────────────────────────────────────────

/**
 * Maximum number of review IDs the contract will return in a single page.
 * Chosen to stay well within Soroban CPU/memory limits for a single
 * simulation; the contract enforces the same cap.
 */
export const MAX_REVIEW_PAGE_SIZE = 50;

/** A single bounded page of review IDs plus the cursor for the next page. */
export interface ReviewIdPage {
  /** Review IDs in deterministic (ascending) order. */
  ids: bigint[];
  /**
   * Cursor to pass as `start` for the next page, or `null` when the
   * collection has been fully traversed.
   */
  nextCursor: bigint | null;
}

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
   * Return a bounded page of review IDs submitted for a given reviewee.
   *
   * ABI: get_reviews_for_user_paged(reviewee: Address, start: u64, limit: u32)
   *        -> Vec<u64>
   *
   * `start` is an exclusive keyset cursor: the first returned ID is strictly
   * greater than `start`. Pass `0n` to begin from the start of the collection.
   * `limit` is clamped to [1, MAX_REVIEW_PAGE_SIZE].
   *
   * `nextCursor` is `null` when fewer than `limit` IDs were returned, meaning
   * the collection has been fully traversed.
   */
  async getReviewsForUserPage(
    reviewee: string,
    start: bigint = 0n,
    limit: number = MAX_REVIEW_PAGE_SIZE,
  ): Promise<ReviewIdPage> {
    if (start < 0n) {
      throw new RangeError(`Cursor must be non-negative, got ${start}`);
    }
    const pageSize = Math.min(
      Math.max(Math.trunc(limit), 1),
      MAX_REVIEW_PAGE_SIZE,
    );

    const result = await this.simulateReadOnly('get_reviews_for_user_paged', [
      nativeToScVal(reviewee, { type: 'address' }),
      nativeToScVal(start, { type: 'u64' }),
      nativeToScVal(pageSize, { type: 'u32' }),
    ]);
    const native = scValToNative(result) as (number | string)[];
    const ids = native.map((v) => BigInt(v));

    const nextCursor =
      ids.length < pageSize ? null : ids[ids.length - 1] ?? null;

    return { ids, nextCursor };
  }

  /**
   * Iterate over every review ID for a reviewee using bounded pages.
   *
   * Yields IDs in deterministic ascending order with no duplicates or gaps.
   * Each page is fetched lazily, so callers can stop early without paying for
   * the remainder of the collection.
   */
  async *iterateReviewsForUser(
    reviewee: string,
    pageSize: number = MAX_REVIEW_PAGE_SIZE,
  ): AsyncGenerator<bigint, void, undefined> {
    let cursor = 0n;
    for (;;) {
      const page = await this.getReviewsForUserPage(reviewee, cursor, pageSize);
      for (const id of page.ids) {
        yield id;
      }
      if (page.nextCursor === null) {
        return;
      }
      cursor = page.nextCursor;
    }
  }

  /**
   * Collect the complete review history for a reviewee by paging internally.
   *
   * Prefer {@link iterateReviewsForUser} for large histories; this helper is
   * provided for callers that need the full list in memory.
   */
  async getAllReviewsForUser(
    reviewee: string,
    pageSize: number = MAX_REVIEW_PAGE_SIZE,
  ): Promise<bigint[]> {
    const all: bigint[] = [];
    for await (const id of this.iterateReviewsForUser(reviewee, pageSize)) {
      all.push(id);
    }
    return all;
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

  // ── Internal helpers ──────────────────────────────────────────────────────

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
