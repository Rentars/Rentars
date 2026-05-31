import {
  Keypair,
  Transaction,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import {
  BASE_FEE,
  NETWORK_PASSPHRASE,
  STELLAR_ADMIN_SECRET,
  STELLAR_SOURCE_ACCOUNT,
} from './config.js';
import { getSorobanServer } from './soroban.js';
import { BlockchainError } from './errors.js';

/**
 * Build an unsigned transaction from a list of operations.
 */
export async function buildTransaction(
  operations: xdr.Operation[],
  sourceAddress: string = STELLAR_SOURCE_ACCOUNT,
): Promise<Transaction> {
  const server = getSorobanServer();
  const account = await server.getAccount(sourceAddress);

  let builder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  });

  for (const op of operations) {
    builder = builder.addOperation(op);
  }

  return builder.setTimeout(30).build();
}

/**
 * Sign a transaction with the given keypair (mutates and returns the transaction).
 */
export function signTransaction(tx: Transaction, keypair: Keypair): Transaction {
  tx.sign(keypair);
  return tx;
}

/**
 * Build, prepare (simulate + fill auth entries), and sign using the server admin keypair.
 */
export async function buildPrepareAndSign(
  server: rpc.Server,
  operations: xdr.Operation[],
): Promise<Transaction> {
  if (!STELLAR_ADMIN_SECRET) {
    throw new BlockchainError(
      'STELLAR_ADMIN_SECRET is not configured',
      'CONFIG_ERROR',
    );
  }

  const adminKeypair = Keypair.fromSecret(STELLAR_ADMIN_SECRET);
  const tx = await buildTransaction(operations, adminKeypair.publicKey());
  const prepared = await server.prepareTransaction(tx);
  (prepared as Transaction).sign(adminKeypair);
  return prepared as Transaction;
}

/**
 * Extract the native return value from a confirmed transaction response.
 */
export function extractReturnValue(
  response: rpc.Api.GetTransactionResponse,
): unknown {
  if (
    response.status !== rpc.Api.GetTransactionStatus.SUCCESS ||
    !response.returnValue
  ) {
    return undefined;
  }
  return scValToNative(response.returnValue);
}
