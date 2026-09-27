/**
 * Wallet / backend Stellar network mismatch protection (#619).
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

function buildSignedXdr(passphrase: string): string {
  const keypair = Keypair.random();
  const account = new Account(keypair.publicKey(), '1');
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: passphrase,
  })
    .addOperation(
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: Asset.native(),
        amount: '1',
      }),
    )
    .setTimeout(30)
    .build();
  tx.sign(keypair);
  return tx.toXDR();
}

describe('blockchain.network', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv, NODE_ENV: 'test' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('getStellarNetwork', () => {
    it('returns testnet in non-production when STELLAR_NETWORK is unset', async () => {
      delete process.env.STELLAR_NETWORK;
      const { getStellarNetwork } = await import('../../src/blockchain/network.js');
      expect(getStellarNetwork()).toBe('testnet');
    });

    it('throws in production when STELLAR_NETWORK is missing', async () => {
      process.env.NODE_ENV = 'production';
      delete process.env.STELLAR_NETWORK;
      const { getStellarNetwork } = await import('../../src/blockchain/network.js');
      expect(() => getStellarNetwork()).toThrow(/STELLAR_NETWORK must be explicitly set/);
    });

    it('throws in production when STELLAR_NETWORK is invalid', async () => {
      process.env.NODE_ENV = 'production';
      process.env.STELLAR_NETWORK = 'devnet';
      const { getStellarNetwork } = await import('../../src/blockchain/network.js');
      expect(() => getStellarNetwork()).toThrow(/STELLAR_NETWORK must be explicitly set/);
    });
  });

  describe('parseAndValidateXdr', () => {
    it('accepts XDR signed for the configured network', async () => {
      process.env.STELLAR_NETWORK = 'testnet';
      const { parseAndValidateXdr } = await import('../../src/blockchain/network.js');
      const xdr = buildSignedXdr(Networks.TESTNET);
      expect(parseAndValidateXdr(xdr)).toBeDefined();
    });

    it('rejects mainnet-signed XDR when server expects testnet', async () => {
      process.env.STELLAR_NETWORK = 'testnet';
      const { parseAndValidateXdr, NetworkMismatchError } = await import(
        '../../src/blockchain/network.js'
      );
      const xdr = buildSignedXdr(Networks.PUBLIC);
      expect(() => parseAndValidateXdr(xdr)).toThrow(NetworkMismatchError);
      try {
        parseAndValidateXdr(xdr);
      } catch (err) {
        expect(err).toBeInstanceOf(NetworkMismatchError);
        const mismatch = err as InstanceType<typeof NetworkMismatchError>;
        expect(mismatch.expectedNetwork).toBe('testnet');
        expect(mismatch.actualNetwork).toBe('mainnet');
      }
    });

    it('rejects testnet-signed XDR when server expects mainnet', async () => {
      process.env.STELLAR_NETWORK = 'mainnet';
      const { parseAndValidateXdr, NetworkMismatchError } = await import(
        '../../src/blockchain/network.js'
      );
      const xdr = buildSignedXdr(Networks.TESTNET);
      expect(() => parseAndValidateXdr(xdr)).toThrow(NetworkMismatchError);
    });
  });

  describe('assertNetworkMatch', () => {
    it('throws when comparing testnet vs mainnet names', async () => {
      process.env.STELLAR_NETWORK = 'testnet';
      const { assertNetworkMatch, NetworkMismatchError } = await import(
        '../../src/blockchain/network.js'
      );
      expect(() => assertNetworkMatch('testnet', 'mainnet')).toThrow(NetworkMismatchError);
    });
  });

  describe('validateEnvNetworkPassphrase', () => {
    it('returns error when passphrase env conflicts with STELLAR_NETWORK', async () => {
      process.env.STELLAR_NETWORK = 'testnet';
      process.env.STELLAR_NETWORK_PASSPHRASE = Networks.PUBLIC;
      const { validateEnvNetworkPassphrase } = await import('../../src/blockchain/network.js');
      expect(validateEnvNetworkPassphrase()).toMatch(/does not match/);
    });
  });
});
