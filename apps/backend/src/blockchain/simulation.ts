import type { Transaction, rpc } from '@stellar/stellar-sdk';
import { assertSimulationSafe, type SimulationResult } from './soroban.js';

export type { SimulationResult };

/**
 * Preflight a transaction and throw if the simulation shows it is not safe to sign.
 * Returns the simulation result (fee estimate, events) for callers that need it.
 */
export function simulateOrThrow(server: rpc.Server, tx: Transaction): Promise<SimulationResult> {
  return assertSimulationSafe(server, tx);
}

/**
 * Result of an environment-safe payment configuration check.
 *
 * `safe` is true when the payment path can be simulated without submitting a
 * transaction or moving funds. `reason` explains a failure when `safe` is false.
 */
export interface PaymentConfigCheckResult {
  safe: boolean;
  simulated: boolean;
  submitted: boolean;
  network: string;
  reason?: string;
}

/**
 * Networks on which a real payment submission would move production funds.
 * The smoke check must never submit on these networks.
 */
const PRODUCTION_NETWORKS = new Set(['public', 'mainnet', 'pubnet']);

function normalizeNetwork(network: string | undefined): string {
  return (network ?? '').trim().toLowerCase();
}

/**
 * Environment-safe payment configuration check for deployment smoke tests.
 *
 * This verifies that the payment path is configured and can be simulated
 * against a testnet or local network. It NEVER submits a transaction and
 * NEVER moves funds:
 *  - If the configured network is a production network, the check fails
 *    immediately without touching the network.
 *  - Otherwise the provided transaction is simulated only (read-only), and
 *    the result reports that nothing was submitted.
 *
 * Callers should gate traffic promotion on `result.safe === true`.
 */
export async function checkPaymentConfig(
  server: rpc.Server,
  tx: Transaction,
  network: string | undefined,
): Promise<PaymentConfigCheckResult> {
  const normalized = normalizeNetwork(network);

  if (PRODUCTION_NETWORKS.has(normalized)) {
    return {
      safe: false,
      simulated: false,
      submitted: false,
      network: normalized,
      reason: `Payment smoke check refused to run on production network "${normalized}"; use testnet or a local network.`,
    };
  }

  try {
    // Simulation is read-only: it does not submit the transaction or move funds.
    await assertSimulationSafe(server, tx);
    return {
      safe: true,
      simulated: true,
      submitted: false,
      network: normalized,
    };
  } catch (error) {
    return {
      safe: false,
      simulated: true,
      submitted: false,
      network: normalized,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}