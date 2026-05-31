import {
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

export function getSorobanServer(): rpc.Server {
  return new rpc.Server(STELLAR_RPC_URL, {
    allowHttp: STELLAR_RPC_URL.startsWith('http://'),
  });
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
