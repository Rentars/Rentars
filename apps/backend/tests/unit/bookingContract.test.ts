/**
 * Unit tests for bookingContract.ts — focused on requireContractId behaviour.
 *
 * BOOKING_CONTRACT_ID is captured as a module-level const at import time from
 * config.ts. To test the missing-ID path we use mock.module to replace the
 * config import with a version that returns an empty BOOKING_CONTRACT_ID,
 * then re-import bookingContract.ts so it picks up the mocked value.
 */

import { describe, it, expect, mock } from 'bun:test';
import { ContractError } from '../../src/blockchain/errors.js';

// Stub out every soroban.js export to prevent accidental network calls if
// requireContractId ever passes (it should not in these tests).
mock.module('../../src/blockchain/soroban.js', () => ({
  getSorobanServer: () => ({}),
  simulateReadOnly: async () => { throw new Error('unexpected network call'); },
  submitAndWait: async () => { throw new Error('unexpected network call'); },
}));

// Override config so BOOKING_CONTRACT_ID is empty.
mock.module('../../src/blockchain/config.js', () => ({
  BOOKING_CONTRACT_ID: '',
  NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
  STELLAR_SOURCE_ACCOUNT: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
}));

// Import bookingContract AFTER mock.module calls so it resolves the mocked config.
const { checkAvailability } = await import('../../src/blockchain/bookingContract.js');

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('bookingContract — requireContractId', () => {
  it('throws ContractError when BOOKING_CONTRACT_ID is not set', async () => {
    let caught: unknown;
    try {
      await checkAvailability(BigInt(1), BigInt(0), BigInt(0));
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ContractError);
  });

  it('error message names the BOOKING_CONTRACT_ID environment variable key', async () => {
    let caught: unknown;
    try {
      await checkAvailability(BigInt(1), BigInt(0), BigInt(0));
    } catch (err) {
      caught = err;
    }

    expect((caught as Error).message).toContain('BOOKING_CONTRACT_ID');
  });

  it('error message is actionable — tells the operator what to do', async () => {
    let caught: unknown;
    try {
      await checkAvailability(BigInt(1), BigInt(0), BigInt(0));
    } catch (err) {
      caught = err;
    }

    const message = (caught as Error).message.toLowerCase();
    expect(message).toMatch(/not set|missing|configure|required|environment variable/);
  });

  it('error message does not contain any contract address or secret value', async () => {
    let caught: unknown;
    try {
      await checkAvailability(BigInt(1), BigInt(0), BigInt(0));
    } catch (err) {
      caught = err;
    }

    const message = (caught as Error).message;
    // Stellar contract strkeys are 56 chars starting with 'C' — none must appear in the message.
    expect(/C[A-Z2-7]{55}/.test(message)).toBe(false);
  });
});
