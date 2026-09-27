/**
 * #617 — Payment & escrow testnet certification suite.
 *
 * Simulated mode runs in CI without secrets.
 * Real testnet mode activates when RUN_TESTNET_TESTS=true and deps are wired.
 */

import { describe, it, expect } from 'bun:test';
import {
  assertNoProductionSecrets,
  formatCertificationFailure,
  provisionDisposableAccounts,
  runPaymentEscrowCertification,
} from '../../src/services/paymentCertification.service.js';

describe('payment & escrow certification (#617)', () => {
  it('provisions disposable accounts without exposing secrets in the report', async () => {
    const accounts = provisionDisposableAccounts();
    expect(accounts).toHaveLength(3);
    expect(accounts.map((a) => a.role).sort()).toEqual(['funder', 'owner', 'tenant']);

    const report = await runPaymentEscrowCertification();
    for (const account of report.accounts) {
      expect(account.publicKey).toBeTruthy();
      expect(account.secretKey).toBe('');
    }
  });

  it('covers booking, USDC, escrow lock, confirm, cancel, refund, timeout, reconcile', async () => {
    const report = await runPaymentEscrowCertification();
    expect(report.passed).toBe(true);
    expect(report.network).toBe('simulated');

    const steps = report.artifacts.map((a) => a.step);
    expect(steps).toEqual([
      'provision_accounts',
      'fund_accounts',
      'booking',
      'usdc_transfer',
      'escrow_lock',
      'confirmation',
      'cancellation',
      'refund',
      'timeout',
      'reconciliation',
    ]);

    for (const artifact of report.artifacts) {
      expect(artifact.correlationId).toBeTruthy();
      expect(artifact.tag).toBeTruthy();
      expect(artifact.status).toBe('passed');
    }

    const withTx = report.artifacts.filter((a) =>
      ['usdc_transfer', 'escrow_lock', 'confirmation', 'cancellation', 'refund'].includes(a.step),
    );
    for (const artifact of withTx) {
      expect(artifact.explorerUrl).toContain('stellar.expert/explorer/testnet/tx/');
      expect(artifact.txHash).toBeTruthy();
    }

    const recon = report.artifacts.find((a) => a.step === 'reconciliation')!;
    expect(recon.reconciliationId).toBeTruthy();
    expect(recon.bookingId).toBeTruthy();
  });

  it('identifies exact booking/tx/reconciliation on a failed step', async () => {
    const report = await runPaymentEscrowCertification({
      reconcile: async ({ bookingId, escrowId, correlationId }) => {
        throw new Error(
          `Reconciliation mismatch booking=${bookingId} escrow=${escrowId} correlation=${correlationId}`,
        );
      },
    });

    expect(report.passed).toBe(false);
    const failure = formatCertificationFailure(report);
    expect(failure).toContain('[FAIL] step=reconciliation');
    expect(failure).toContain('bookingId=');
    expect(failure).toContain('correlationId=');
    expect(failure).toContain('error=');
  });

  it('refuses to run when production secrets are present', () => {
    const prev = process.env.MAINNET_SECRET_KEY;
    process.env.MAINNET_SECRET_KEY = 'prod-secret-should-block';
    try {
      expect(() => assertNoProductionSecrets()).toThrow(/production secret/);
    } finally {
      if (prev === undefined) delete process.env.MAINNET_SECRET_KEY;
      else process.env.MAINNET_SECRET_KEY = prev;
    }
  });

  it('tags every transaction for controlled testnet tracing', async () => {
    const report = await runPaymentEscrowCertification();
    const tags = new Set(report.artifacts.map((a) => a.tag));
    expect(tags.size).toBeGreaterThanOrEqual(8);
  });
});

const runTestnet = process.env.RUN_TESTNET_TESTS === 'true';

(runTestnet ? describe : describe.skip)('payment & escrow certification (live testnet)', () => {
  it('runs against configured contract IDs without production secrets', async () => {
    assertNoProductionSecrets();
    expect(process.env.SOROBAN_CONTRACT_ID || process.env.STELLAR_NETWORK).toBeTruthy();

    // Live wiring is intentionally thin here: operators plug TrustlessWork /
    // Horizon clients via RUN_TESTNET_TESTS + .env.testnet. This assertion
    // documents the gate; full chain calls belong in the operator runbook.
    const report = await runPaymentEscrowCertification({
      contractId: process.env.SOROBAN_CONTRACT_ID,
    });
    expect(report.runId).toBeTruthy();
  });
});
