/**
 * Stellar Horizon transaction confirmation polling (#622).
 *
 * Bounded exponential-backoff polling with confirmation depth policy.
 * On deadline without confirmation, returns awaiting_reconciliation (not failed).
 */

import { Horizon } from '@stellar/stellar-sdk';

export interface ConfirmationPolicy {
  initialDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
  timeoutMs: number;
  /** Ledgers past inclusion required before treating as confirmed (Horizon default: 1). */
  requiredConfirmations: number;
}

export const DEFAULT_CONFIRMATION_POLICY: ConfirmationPolicy = {
  initialDelayMs: 1_000,
  maxDelayMs: 8_000,
  backoffFactor: 2,
  timeoutMs: 60_000,
  requiredConfirmations: 1,
};

export type TxOutcomeClass = 'not_found' | 'pending' | 'failed' | 'confirmed';

export type PollUntilConfirmedResult =
  | { status: 'confirmed'; ledger: number }
  | { status: 'failed' }
  | { status: 'awaiting_reconciliation' };

export interface HorizonTransactionSnapshot {
  successful: boolean;
  ledger: number;
}

export type FetchTransactionFn = (
  txHash: string,
) => Promise<HorizonTransactionSnapshot | 'not_found' | 'error'>;

export type FetchLedgerHeadFn = () => Promise<number>;

function isNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes('404') || err.message.includes('not found');
}

/**
 * Classify a Horizon transaction lookup into a canonical outcome.
 */
export function classifyTxOutcome(
  lookup:
    | HorizonTransactionSnapshot
    | 'not_found'
    | 'error'
    | null
    | undefined,
  opts: {
    ledgerHead?: number;
    requiredConfirmations?: number;
  } = {},
): TxOutcomeClass {
  if (lookup === 'not_found' || lookup == null) {
    return 'not_found';
  }
  if (lookup === 'error') {
    return 'pending';
  }
  if (!lookup.successful) {
    return 'failed';
  }

  const depth = opts.requiredConfirmations ?? 1;
  if (depth <= 1) {
    return 'confirmed';
  }

  const ledgerHead = opts.ledgerHead;
  if (ledgerHead == null || !Number.isFinite(ledgerHead)) {
    return 'pending';
  }

  const confirmations = ledgerHead - lookup.ledger + 1;
  return confirmations >= depth ? 'confirmed' : 'pending';
}

/**
 * Build a fetchTransaction adapter from a Horizon server instance.
 */
export function horizonFetchTransaction(server: Horizon.Server): FetchTransactionFn {
  return async (txHash: string) => {
    try {
      const tx = await server.transactions().transaction(txHash).call();
      return {
        successful: Boolean(tx.successful),
        ledger: tx.ledger,
      };
    } catch (err: unknown) {
      if (isNotFoundError(err)) {
        return 'not_found';
      }
      return 'error';
    }
  };
}

export function horizonFetchLedgerHead(server: Horizon.Server): FetchLedgerHeadFn {
  return async () => {
    const ledgers = await server.ledgers().order('desc').limit(1).call();
    const head = ledgers.records[0]?.sequence;
    if (head == null) {
      throw new Error('Horizon returned no ledger head');
    }
    return typeof head === 'string' ? Number.parseInt(head, 10) : head;
  };
}

export interface PollUntilConfirmedOptions {
  policy?: Partial<ConfirmationPolicy>;
  fetchTransaction: FetchTransactionFn;
  fetchLedgerHead?: FetchLedgerHeadFn;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Poll until the transaction is confirmed, failed on-chain, or the deadline passes.
 */
export async function pollUntilConfirmed(
  txHash: string,
  opts: PollUntilConfirmedOptions,
): Promise<PollUntilConfirmedResult> {
  const policy: ConfirmationPolicy = {
    ...DEFAULT_CONFIRMATION_POLICY,
    ...opts.policy,
  };
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());

  const deadline = now() + policy.timeoutMs;
  let delayMs = policy.initialDelayMs;

  while (now() < deadline) {
    const lookup = await opts.fetchTransaction(txHash);
    let ledgerHead: number | undefined;
    if (
      lookup !== 'not_found' &&
      lookup !== 'error' &&
      policy.requiredConfirmations > 1 &&
      opts.fetchLedgerHead
    ) {
      try {
        ledgerHead = await opts.fetchLedgerHead();
      } catch {
        ledgerHead = undefined;
      }
    }

    const outcome = classifyTxOutcome(lookup, {
      ledgerHead,
      requiredConfirmations: policy.requiredConfirmations,
    });

    if (outcome === 'confirmed' && lookup !== 'not_found' && lookup !== 'error') {
      return { status: 'confirmed', ledger: lookup.ledger };
    }
    if (outcome === 'failed') {
      return { status: 'failed' };
    }

    const remaining = deadline - now();
    if (remaining <= 0) {
      break;
    }

    const waitMs = Math.min(delayMs, remaining);
    await sleep(waitMs);
    delayMs = Math.min(Math.floor(delayMs * policy.backoffFactor), policy.maxDelayMs);
  }

  return { status: 'awaiting_reconciliation' };
}
