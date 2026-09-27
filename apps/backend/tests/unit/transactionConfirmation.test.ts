/**
 * Unit tests for Stellar transaction confirmation polling (#622).
 */

import { describe, it, expect, mock } from 'bun:test';
import {
  classifyTxOutcome,
  pollUntilConfirmed,
  DEFAULT_CONFIRMATION_POLICY,
  type FetchTransactionFn,
} from '../../src/services/transactionConfirmation.service.js';

describe('transactionConfirmation.classifyTxOutcome', () => {
  it('classifies not_found', () => {
    expect(classifyTxOutcome('not_found')).toBe('not_found');
    expect(classifyTxOutcome(null)).toBe('not_found');
  });

  it('classifies Horizon errors as pending (retryable)', () => {
    expect(classifyTxOutcome('error')).toBe('pending');
  });

  it('classifies unsuccessful on-chain tx as failed', () => {
    expect(classifyTxOutcome({ successful: false, ledger: 10 })).toBe('failed');
  });

  it('classifies successful tx as confirmed when depth is 1', () => {
    expect(classifyTxOutcome({ successful: true, ledger: 10 })).toBe('confirmed');
  });

  it('requires ledger depth when requiredConfirmations > 1', () => {
    expect(
      classifyTxOutcome({ successful: true, ledger: 100 }, {
        ledgerHead: 100,
        requiredConfirmations: 2,
      }),
    ).toBe('pending');

    expect(
      classifyTxOutcome({ successful: true, ledger: 100 }, {
        ledgerHead: 101,
        requiredConfirmations: 2,
      }),
    ).toBe('confirmed');
  });
});

describe('transactionConfirmation.pollUntilConfirmed', () => {
  it('returns confirmed when tx becomes successful', async () => {
    let calls = 0;
    const fetchTransaction: FetchTransactionFn = mock(async () => {
      calls++;
      if (calls < 2) return 'not_found';
      return { successful: true, ledger: 42 };
    });

    const result = await pollUntilConfirmed('abc', {
      fetchTransaction,
      policy: {
        ...DEFAULT_CONFIRMATION_POLICY,
        initialDelayMs: 1,
        maxDelayMs: 1,
        timeoutMs: 500,
      },
      sleep: async () => {},
    });

    expect(result).toEqual({ status: 'confirmed', ledger: 42 });
    expect(calls).toBe(2);
  });

  it('uses exponential backoff between polls', async () => {
    const delays: number[] = [];
    const fetchTransaction: FetchTransactionFn = mock(async () => 'not_found');

    await pollUntilConfirmed('abc', {
      fetchTransaction,
      policy: {
        ...DEFAULT_CONFIRMATION_POLICY,
        initialDelayMs: 10,
        maxDelayMs: 40,
        backoffFactor: 2,
        timeoutMs: 100,
      },
      sleep: async (ms) => {
        delays.push(ms);
      },
      now: (() => {
        let t = 0;
        return () => {
          t += 15;
          return t;
        };
      })(),
    });

    expect(delays.length).toBeGreaterThan(0);
    expect(delays[0]).toBe(10);
    if (delays.length > 1) {
      expect(delays[1]).toBe(20);
    }
  });

  it('returns awaiting_reconciliation at deadline without marking failed', async () => {
    const fetchTransaction: FetchTransactionFn = mock(async () => 'not_found');

    const result = await pollUntilConfirmed('abc', {
      fetchTransaction,
      policy: {
        ...DEFAULT_CONFIRMATION_POLICY,
        initialDelayMs: 1,
        maxDelayMs: 1,
        timeoutMs: 5,
      },
      sleep: async () => {},
      now: (() => {
        let t = 0;
        return () => (t += 10);
      })(),
    });

    expect(result).toEqual({ status: 'awaiting_reconciliation' });
  });

  it('returns failed for on-chain unsuccessful tx', async () => {
    const fetchTransaction: FetchTransactionFn = mock(async () => ({
      successful: false,
      ledger: 1,
    }));

    const result = await pollUntilConfirmed('abc', {
      fetchTransaction,
      policy: { ...DEFAULT_CONFIRMATION_POLICY, timeoutMs: 100 },
      sleep: async () => {},
    });

    expect(result).toEqual({ status: 'failed' });
  });
});
