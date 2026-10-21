import {
  Account,
  FeeBumpTransaction,
  Keypair,
  Transaction,
  TransactionBuilder,
  rpc,
  xdr,
} from '@stellar/stellar-sdk';
import { BASE_FEE, NETWORK_PASSPHRASE, STELLAR_RPC_URL } from './config.js';
import { TransactionError } from './errors.js';

const POLL_INTERVAL_MS = 1000;
const MAX_POLL_ATTEMPTS = 30;

const SIMULATION_CACHE_TTL_MS = 5000;

export function getSorobanServer(): rpc.Server {
  return new rpc.Server(STELLAR_RPC_URL, {
    allowHttp: STELLAR_RPC_URL.startsWith('http://'),
  });
}

const RPC_HEALTH_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Stellar RPC health check timed out')), ms);
    }),
  ]);
}

/**
 * Verify Stellar RPC connectivity with a bounded-time getHealth() probe.
 *
 * @returns true if the RPC endpoint reports "healthy" within the timeout, false otherwise
 */
export async function getRpcHealth(): Promise<boolean> {
  try {
    const server = getSorobanServer();
    const health = await withTimeout(server.getHealth(), RPC_HEALTH_TIMEOUT_MS);
    return health.status === 'healthy';
  } catch {
    return false;
  }
}

/**
 * Submit a signed Soroban transaction and poll until it is confirmed.
 */
export async function submitAndWait(
  server: rpc.Server,
  tx: Transaction,
): Promise<rpc.Api.GetTransactionResponse> {
  const sendResponse = await server.sendTransaction(tx);

  if (sendResponse.status === 'ERROR') {
    const detail =
      sendResponse.errorResult?.toXDR('base64') ?? 'unknown error';
    throw new TransactionError(`Transaction submission failed: ${detail}`);
  }

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    const getResponse = await server.getTransaction(sendResponse.hash);

    if (getResponse.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) {
      if (getResponse.status === rpc.Api.GetTransactionStatus.FAILED) {
        throw new TransactionError(
          'Transaction failed on-chain',
          sendResponse.hash,
        );
      }
      return getResponse;
    }

    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new TransactionError(
    `Transaction not confirmed after ${MAX_POLL_ATTEMPTS} attempts`,
    sendResponse.hash,
  );
}

/**
 * Wrap an inner transaction in a fee-bump and sign with the fee-source keypair.
 */
export function buildFeeBump(
  innerTx: Transaction,
  feeSourceKeypair: Keypair,
): FeeBumpTransaction {
  const bumpFee = String(Math.max(200, Number(BASE_FEE) * 10));
  const feeBump = TransactionBuilder.buildFeeBumpTransaction(
    feeSourceKeypair,
    bumpFee,
    innerTx,
    NETWORK_PASSPHRASE,
  );
  feeBump.sign(feeSourceKeypair);
  return feeBump;
}

/**
 * Simulate a read-only contract call and return the result ScVal.
 */
export async function simulateReadOnly(
  server: rpc.Server,
  tx: Transaction,
  methodName: string,
): Promise<xdr.ScVal> {
  const simResult = await server.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(simResult)) {
    throw new TransactionError(
      `Simulation failed for ${methodName}: ${(simResult as rpc.Api.SimulateTransactionErrorResponse).error}`,
    );
  }

  const success = simResult as rpc.Api.SimulateTransactionSuccessResponse;
  if (!success.result?.retval) {
    throw new TransactionError(`No return value from ${methodName}`);
  }

  return success.result.retval;
}

/**
 * Result of a preflight simulation, including estimated fee and diagnostics.
 */
export interface SimulationResult {
  success: boolean;
  estimatedFee: string;
  minResourceFee: string;
  latestLedger: number;
  error?: string;
  recoverable?: boolean;
  errorClass?: SimulationErrorClass;
  events?: string[];
}

interface SimulationCacheEntry {
  result: SimulationResult;
  ledger: number;
  expiresAt: number;
}

const simulationCache = new Map<string, SimulationCacheEntry>();

/**
 * Derive a stable cache key from a transaction's intent (source, ops, seq)
 * plus the network it targets. Including the network passphrase prevents a
 * simulation run against one network (e.g. testnet) from being served back
 * for an otherwise-identical transaction intent on another network (e.g.
 * mainnet) that happens to share the same source/sequence/ops shape.
 */
function simulationCacheKey(tx: Transaction): string {
  const ops = tx.operations
    .map((op) => JSON.stringify(op))
    .join('|');
  return `${NETWORK_PASSPHRASE}|${tx.source}|${tx.sequence}|${ops}`;
}

/**
 * Coarse classification of a preflight simulation failure, so callers (and
 * the UI) can show a useful, specific reason instead of a raw RPC error
 * string.
 *
 * - `auth`: the transaction/contract invocation was not properly authorized
 *   (missing/invalid signature, auth entry, or allowance).
 * - `resource_limit`: the operation would exceed Soroban resource limits
 *   (CPU instructions, memory, ledger entry read/write limits, tx size).
 * - `balance`: insufficient balance or trustline to cover the operation.
 * - `network`: the simulation itself could not be completed (RPC/timeout).
 * - `unknown`: a recognized-but-unclassified contract error.
 */
export type SimulationErrorClass =
  | 'auth'
  | 'resource_limit'
  | 'balance'
  | 'network'
  | 'unknown';

/**
 * Parse simulation diagnostics into a safe, non-throwing summary.
 */
function parseSimulationDiagnostics(
  simResult: rpc.Api.SimulateTransactionResponse,
): { error?: string; recoverable: boolean; errorClass: SimulationErrorClass } {
  if (!rpc.Api.isSimulationError(simResult)) {
    return { recoverable: false, errorClass: 'unknown' };
  }

  const errResponse = simResult as rpc.Api.SimulateTransactionErrorResponse;
  const raw = errResponse.error ?? 'unknown simulation error';

  let errorClass: SimulationErrorClass = 'unknown';
  if (/resource.?limit|instructions exceed|memory exceed|read.?byte|write.?byte|tx too large|exceeds the limit/i.test(raw)) {
    errorClass = 'resource_limit';
  } else if (/auth|signature|not authorized|invalid.*auth|missing.*entry/i.test(raw)) {
    errorClass = 'auth';
  } else if (/balance|trustline|allowance|underfunded/i.test(raw)) {
    errorClass = 'balance';
  } else if (/timeout|network|connection|unavailable/i.test(raw)) {
    errorClass = 'network';
  } else if (/contract/i.test(raw) || errResponse.events?.some((e) => e.type === 'contract')) {
    errorClass = 'unknown';
  }

  // Contract/auth/resource/balance failures are typically recoverable (the
  // user can fix the underlying input and re-simulate); network failures are
  // transient and should prompt a retry rather than a hard stop.
  const recoverable = errorClass !== 'network';

  return { error: raw, recoverable, errorClass };
}

/**
 * Simulate a transaction to estimate fees and surface preflight failures.
 *
 * Results are cached briefly by transaction intent and invalidated when the
 * latest ledger advances or the transaction inputs change.
 */
export async function simulateTransaction(
  server: rpc.Server,
  tx: Transaction,
): Promise<SimulationResult> {
  const key = simulationCacheKey(tx);
  const now = Date.now();
  const cached = simulationCache.get(key);

  if (cached && cached.expiresAt > now) {
    try {
      const latest = await server.getLatestLedger();
      if (latest.sequence === cached.ledger) {
        return cached.result;
      }
    } catch {
      // Fall through to re-simulate if ledger lookup fails.
    }
  }

  let latestLedger = 0;
  try {
    const latest = await server.getLatestLedger();
    latestLedger = latest.sequence;
  } catch {
    latestLedger = 0;
  }

  const simResult = await server.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(simResult)) {
    const { error, recoverable, errorClass } = parseSimulationDiagnostics(simResult);
    const result: SimulationResult = {
      success: false,
      estimatedFee: '0',
      minResourceFee: '0',
      latestLedger,
      error,
      recoverable,
      errorClass,
    };
    simulationCache.set(key, {
      result,
      ledger: latestLedger,
      expiresAt: now + SIMULATION_CACHE_TTL_MS,
    });
    return result;
  }

  const success = simResult as rpc.Api.SimulateTransactionSuccessResponse;
  const minResourceFee = success.minResourceFee ?? '0';
  const estimatedFee = String(
    Number(BASE_FEE) + Number(minResourceFee),
  );

  const result: SimulationResult = {
    success: true,
    estimatedFee,
    minResourceFee,
    latestLedger,
    events: success.events?.map((e) => e.type) ?? [],
  };

  simulationCache.set(key, {
    result,
    ledger: latestLedger,
    expiresAt: now + SIMULATION_CACHE_TTL_MS,
  });

  return result;
}

/**
 * Simulate a transaction and throw if it is not safe to sign.
 *
 * Prevents signing obviously invalid operations by failing fast on
 * unrecoverable simulation errors.
 */
export async function assertSimulationSafe(
  server: rpc.Server,
  tx: Transaction,
): Promise<SimulationResult> {
  const result = await simulateTransaction(server, tx);

  if (!result.success) {
    const classLabel = result.errorClass ? ` [${result.errorClass}]` : '';
    throw new TransactionError(
      `Preflight simulation failed${classLabel}: ${result.error ?? 'unknown error'}`,
    );
  }

  return result;
}

/**
 * Build a transaction from a source account for simulation purposes.
 */
export function buildSimulationTransaction(
  sourceAccount: Account,
  operations: xdr.Operation[],
  fee = BASE_FEE,
): Transaction {
  const builder = new TransactionBuilder(sourceAccount, {
    fee,
    networkPassphrase: NETWORK_PASSPHRASE,
  });

  for (const op of operations) {
    builder.addOperation(op);
  }

  return builder.setTimeout(30).build();
}

/**
 * Clear cached simulation results, e.g. when a quote changes.
 */
export function invalidateSimulationCache(): void {
  simulationCache.clear();
}
