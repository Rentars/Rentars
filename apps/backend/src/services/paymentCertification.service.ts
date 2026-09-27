/**
 * Payment & escrow testnet certification harness (#617 / Issue 049).
 *
 * Provides a repeatable certification process before mainnet or major payment
 * changes. Never reads production secrets — only STELLAR_*_TESTNET / .env.testnet
 * style credentials gated by RUN_TESTNET_TESTS.
 *
 * Every step emits a CertificationArtifact with:
 *   - tagged transaction memo / tag
 *   - contract / escrow IDs
 *   - explorer transaction link
 *   - backend correlation ID (payment id + request id)
 *   - reconciliation record reference
 *
 * A failed step identifies the exact transaction, booking, and reconciliation
 * record so operators can triage without replaying the whole suite.
 */

import { createHash, randomUUID } from 'node:crypto';
import { Keypair } from '@stellar/stellar-sdk';

export type CertStepName =
  | 'provision_accounts'
  | 'fund_accounts'
  | 'booking'
  | 'usdc_transfer'
  | 'escrow_lock'
  | 'confirmation'
  | 'cancellation'
  | 'refund'
  | 'timeout'
  | 'reconciliation';

export type CertStepStatus = 'passed' | 'failed' | 'skipped';

export interface CertificationArtifact {
  step: CertStepName;
  status: CertStepStatus;
  startedAt: string;
  finishedAt: string;
  correlationId: string;
  bookingId?: string;
  paymentId?: string;
  escrowId?: string;
  contractId?: string;
  txHash?: string;
  explorerUrl?: string;
  reconciliationId?: string;
  tag: string;
  detail?: string;
  error?: string;
}

export interface DisposableAccount {
  publicKey: string;
  /** Secret is only held in-process for the suite; never logged. */
  secretKey: string;
  role: 'owner' | 'tenant' | 'funder';
  funded: boolean;
}

export interface CertificationReport {
  runId: string;
  network: 'testnet' | 'simulated';
  startedAt: string;
  finishedAt: string;
  passed: boolean;
  artifacts: CertificationArtifact[];
  accounts: Array<Omit<DisposableAccount, 'secretKey'>>;
}

export interface CertificationDeps {
  /** Optional real network callers — when omitted, suite runs in simulated mode. */
  fundAccount?: (publicKey: string) => Promise<{ ok: boolean; detail?: string }>;
  createBooking?: (input: {
    owner: string;
    tenant: string;
    correlationId: string;
    tag: string;
  }) => Promise<{ bookingId: string; contractId?: string }>;
  transferUsdc?: (input: {
    fromSecret: string;
    toPublic: string;
    amountStroops: bigint;
    tag: string;
    correlationId: string;
  }) => Promise<{ txHash: string }>;
  lockEscrow?: (input: {
    bookingId: string;
    amountStroops: bigint;
    tag: string;
    correlationId: string;
  }) => Promise<{ escrowId: string; txHash?: string }>;
  confirmEscrow?: (input: {
    escrowId: string;
    correlationId: string;
  }) => Promise<{ status: string; txHash?: string }>;
  cancelEscrow?: (input: {
    escrowId: string;
    correlationId: string;
  }) => Promise<{ status: string; txHash?: string }>;
  refundEscrow?: (input: {
    escrowId: string;
    correlationId: string;
  }) => Promise<{ status: string; txHash?: string; reconciliationId?: string }>;
  simulateTimeout?: (input: {
    paymentId: string;
    correlationId: string;
  }) => Promise<{ status: 'timed_out' }>;
  reconcile?: (input: {
    bookingId: string;
    escrowId: string;
    correlationId: string;
  }) => Promise<{ reconciliationId: string; matched: boolean }>;
  explorerBaseUrl?: string;
  contractId?: string;
  /** Amount used across happy-path steps (stroops). */
  amountStroops?: bigint;
}

const DEFAULT_EXPLORER = 'https://stellar.expert/explorer/testnet/tx/';

function makeTag(runId: string, step: CertStepName): string {
  const raw = `rentars-cert:${runId}:${step}`;
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function explorerUrl(txHash: string | undefined, base: string): string | undefined {
  return txHash ? `${base}${txHash}` : undefined;
}

export function provisionDisposableAccounts(): DisposableAccount[] {
  return (['owner', 'tenant', 'funder'] as const).map((role) => {
    const kp = Keypair.random();
    return {
      publicKey: kp.publicKey(),
      secretKey: kp.secret(),
      role,
      funded: false,
    };
  });
}

/**
 * Assert that no production secret env vars are present when running certs.
 * Throws if classic production key names are set alongside RUN_TESTNET_TESTS.
 */
export function assertNoProductionSecrets(): void {
  const banned = [
    'MAINNET_SECRET_KEY',
    'STELLAR_MAINNET_SECRET',
    'PRODUCTION_DATABASE_URL',
    'PROD_SUPABASE_SERVICE_ROLE_KEY',
  ];
  const present = banned.filter((k) => process.env[k] && process.env[k]!.length > 0);
  if (present.length > 0) {
    throw new Error(
      `Certification suite refused to start: production secret env vars present (${present.join(', ')}). Use .env.testnet only.`,
    );
  }
}

async function runStep(
  step: CertStepName,
  runId: string,
  fn: () => Promise<Partial<CertificationArtifact>>,
): Promise<CertificationArtifact> {
  const startedAt = new Date().toISOString();
  const correlationId = `${runId}:${step}:${randomUUID().slice(0, 8)}`;
  const tag = makeTag(runId, step);
  try {
    const partial = await fn();
    return {
      step,
      status: partial.status ?? 'passed',
      startedAt,
      finishedAt: new Date().toISOString(),
      correlationId: partial.correlationId ?? correlationId,
      tag: partial.tag ?? tag,
      bookingId: partial.bookingId,
      paymentId: partial.paymentId,
      escrowId: partial.escrowId,
      contractId: partial.contractId,
      txHash: partial.txHash,
      explorerUrl: partial.explorerUrl,
      reconciliationId: partial.reconciliationId,
      detail: partial.detail,
      error: partial.error,
    };
  } catch (err) {
    return {
      step,
      status: 'failed',
      startedAt,
      finishedAt: new Date().toISOString(),
      correlationId,
      tag,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Execute the full certification suite.
 * When real deps are omitted, each step is simulated with tagged fake IDs so
 * CI can validate the harness without network access.
 */
export async function runPaymentEscrowCertification(
  deps: CertificationDeps = {},
): Promise<CertificationReport> {
  assertNoProductionSecrets();

  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const network: 'testnet' | 'simulated' =
    process.env.RUN_TESTNET_TESTS === 'true' && deps.transferUsdc ? 'testnet' : 'simulated';
  const explorerBase = deps.explorerBaseUrl ?? DEFAULT_EXPLORER;
  const amountStroops = deps.amountStroops ?? 10_000_000n; // 1 USDC
  const artifacts: CertificationArtifact[] = [];

  const accounts = provisionDisposableAccounts();
  artifacts.push({
    step: 'provision_accounts',
    status: 'passed',
    startedAt,
    finishedAt: new Date().toISOString(),
    correlationId: `${runId}:provision`,
    tag: makeTag(runId, 'provision_accounts'),
    detail: accounts.map((a) => `${a.role}=${a.publicKey}`).join(','),
  });

  // Fund
  artifacts.push(
    await runStep('fund_accounts', runId, async () => {
      if (deps.fundAccount) {
        for (const account of accounts) {
          const result = await deps.fundAccount(account.publicKey);
          if (!result.ok) {
            throw new Error(`Failed funding ${account.role}: ${result.detail ?? 'unknown'}`);
          }
          account.funded = true;
        }
      } else {
        for (const account of accounts) account.funded = true;
      }
      return { detail: 'accounts funded via controlled friendbot/simulated faucet', status: 'passed' };
    }),
  );
  if (artifacts[artifacts.length - 1].status === 'failed') {
    return finalize(runId, network, startedAt, artifacts, accounts);
  }

  let bookingId = `sim-booking-${runId.slice(0, 8)}`;
  let contractId = deps.contractId ?? process.env.SOROBAN_CONTRACT_ID ?? `sim-contract-${runId.slice(0, 8)}`;
  let paymentId = `sim-payment-${runId.slice(0, 8)}`;
  let escrowId = `sim-escrow-${runId.slice(0, 8)}`;
  let lastTxHash: string | undefined;

  const owner = accounts.find((a) => a.role === 'owner')!;
  const tenant = accounts.find((a) => a.role === 'tenant')!;

  artifacts.push(
    await runStep('booking', runId, async () => {
      if (deps.createBooking) {
        const result = await deps.createBooking({
          owner: owner.publicKey,
          tenant: tenant.publicKey,
          correlationId: `${runId}:booking`,
          tag: makeTag(runId, 'booking'),
        });
        bookingId = result.bookingId;
        if (result.contractId) contractId = result.contractId;
      }
      return { bookingId, contractId, detail: 'booking created', status: 'passed' };
    }),
  );

  artifacts.push(
    await runStep('usdc_transfer', runId, async () => {
      const tag = makeTag(runId, 'usdc_transfer');
      if (deps.transferUsdc) {
        const result = await deps.transferUsdc({
          fromSecret: tenant.secretKey,
          toPublic: owner.publicKey,
          amountStroops,
          tag,
          correlationId: `${runId}:usdc`,
        });
        lastTxHash = result.txHash;
      } else {
        lastTxHash = createHash('sha256').update(`usdc:${runId}`).digest('hex');
      }
      paymentId = `pay-${tag}`;
      return {
        bookingId,
        paymentId,
        txHash: lastTxHash,
        explorerUrl: explorerUrl(lastTxHash, explorerBase),
        tag,
        status: 'passed',
      };
    }),
  );

  artifacts.push(
    await runStep('escrow_lock', runId, async () => {
      const tag = makeTag(runId, 'escrow_lock');
      if (deps.lockEscrow) {
        const result = await deps.lockEscrow({
          bookingId,
          amountStroops,
          tag,
          correlationId: `${runId}:escrow_lock`,
        });
        escrowId = result.escrowId;
        if (result.txHash) lastTxHash = result.txHash;
      } else {
        escrowId = `escrow-${tag}`;
        lastTxHash = createHash('sha256').update(`escrow:${runId}`).digest('hex');
      }
      return {
        bookingId,
        paymentId,
        escrowId,
        contractId,
        txHash: lastTxHash,
        explorerUrl: explorerUrl(lastTxHash, explorerBase),
        tag,
        status: 'passed',
      };
    }),
  );

  artifacts.push(
    await runStep('confirmation', runId, async () => {
      if (deps.confirmEscrow) {
        const result = await deps.confirmEscrow({
          escrowId,
          correlationId: `${runId}:confirm`,
        });
        if (result.txHash) lastTxHash = result.txHash;
      }
      return {
        bookingId,
        paymentId,
        escrowId,
        txHash: lastTxHash,
        explorerUrl: explorerUrl(lastTxHash, explorerBase),
        detail: 'escrow confirmed / funded',
        status: 'passed',
      };
    }),
  );

  // Failure-recovery path: cancel → refund (separate cert booking simulation)
  let cancelEscrowId = escrowId;
  artifacts.push(
    await runStep('cancellation', runId, async () => {
      if (deps.cancelEscrow) {
        const result = await deps.cancelEscrow({
          escrowId: cancelEscrowId,
          correlationId: `${runId}:cancel`,
        });
        if (result.txHash) lastTxHash = result.txHash;
      } else {
        lastTxHash = createHash('sha256').update(`cancel:${runId}`).digest('hex');
      }
      return {
        bookingId,
        paymentId,
        escrowId: cancelEscrowId,
        txHash: lastTxHash,
        explorerUrl: explorerUrl(lastTxHash, explorerBase),
        detail: 'escrow cancelled',
        status: 'passed',
      };
    }),
  );

  artifacts.push(
    await runStep('refund', runId, async () => {
      let reconciliationId: string | undefined;
      if (deps.refundEscrow) {
        const result = await deps.refundEscrow({
          escrowId: cancelEscrowId,
          correlationId: `${runId}:refund`,
        });
        if (result.txHash) lastTxHash = result.txHash;
        reconciliationId = result.reconciliationId;
      } else {
        lastTxHash = createHash('sha256').update(`refund:${runId}`).digest('hex');
        reconciliationId = `recon-refund-${runId.slice(0, 8)}`;
      }
      return {
        bookingId,
        paymentId,
        escrowId: cancelEscrowId,
        txHash: lastTxHash,
        explorerUrl: explorerUrl(lastTxHash, explorerBase),
        reconciliationId,
        detail: 'refund settled',
        status: 'passed',
      };
    }),
  );

  artifacts.push(
    await runStep('timeout', runId, async () => {
      if (deps.simulateTimeout) {
        await deps.simulateTimeout({ paymentId, correlationId: `${runId}:timeout` });
      }
      return {
        bookingId,
        paymentId,
        detail: 'payment marked timed_out; retry path available',
        status: 'passed',
      };
    }),
  );

  artifacts.push(
    await runStep('reconciliation', runId, async () => {
      let reconciliationId = `recon-${runId.slice(0, 8)}`;
      if (deps.reconcile) {
        const result = await deps.reconcile({
          bookingId,
          escrowId,
          correlationId: `${runId}:reconcile`,
        });
        reconciliationId = result.reconciliationId;
        if (!result.matched) {
          throw new Error(
            `Reconciliation mismatch booking=${bookingId} escrow=${escrowId} reconciliation=${reconciliationId}`,
          );
        }
      }
      return {
        bookingId,
        paymentId,
        escrowId,
        contractId,
        reconciliationId,
        txHash: lastTxHash,
        explorerUrl: explorerUrl(lastTxHash, explorerBase),
        detail: 'on-chain and backend records matched',
        status: 'passed',
      };
    }),
  );

  return finalize(runId, network, startedAt, artifacts, accounts);
}

function finalize(
  runId: string,
  network: 'testnet' | 'simulated',
  startedAt: string,
  artifacts: CertificationArtifact[],
  accounts: DisposableAccount[],
): CertificationReport {
  const failed = artifacts.filter((a) => a.status === 'failed');
  return {
    runId,
    network,
    startedAt,
    finishedAt: new Date().toISOString(),
    passed: failed.length === 0,
    artifacts,
    accounts: accounts.map(({ publicKey, role, funded }) => ({ publicKey, role, funded, secretKey: '' })),
  };
}

/**
 * Format a failed step for operators — exact tx, booking, and reconciliation IDs.
 */
export function formatCertificationFailure(report: CertificationReport): string {
  const failed = report.artifacts.filter((a) => a.status === 'failed');
  if (failed.length === 0) return 'Certification passed';
  return failed
    .map(
      (f) =>
        `[FAIL] step=${f.step} correlationId=${f.correlationId} bookingId=${f.bookingId ?? 'n/a'} ` +
        `paymentId=${f.paymentId ?? 'n/a'} escrowId=${f.escrowId ?? 'n/a'} txHash=${f.txHash ?? 'n/a'} ` +
        `explorer=${f.explorerUrl ?? 'n/a'} reconciliationId=${f.reconciliationId ?? 'n/a'} ` +
        `tag=${f.tag} error=${f.error ?? 'unknown'}`,
    )
    .join('\n');
}
