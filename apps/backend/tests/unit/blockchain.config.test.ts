/**
 * Unit tests for blockchain configuration validation.
 * Tests contract address validation, network config, and feature flags.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { validateBlockchainConfig } from '../../src/blockchain/config.js';

describe('blockchain.config', () => {
  describe('validateBlockchainConfig', () => {
    it('should pass validation with valid configuration', () => {
      // Save current env
      const originalEnv = process.env;
      process.env = {
        ...originalEnv,
        STELLAR_NETWORK: 'testnet',
        STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
        STELLAR_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
        BLOCKCHAIN_FEATURES_ENABLED: 'false',
      };

      const errors = validateBlockchainConfig();
      expect(errors).toHaveLength(0);

      process.env = originalEnv;
    });

    it('should fail when STELLAR_RPC_URL is invalid', () => {
      const originalEnv = process.env;
      process.env = {
        ...originalEnv,
        STELLAR_RPC_URL: 'invalid-url',
        BLOCKCHAIN_FEATURES_ENABLED: 'false',
      };

      const errors = validateBlockchainConfig();
      const rpcError = errors.find((e) => e.field === 'STELLAR_RPC_URL');
      expect(rpcError).toBeDefined();
      expect(rpcError?.message).toContain('Invalid RPC URL');

      process.env = originalEnv;
    });

    it('should fail when STELLAR_NETWORK_PASSPHRASE conflicts with STELLAR_NETWORK', () => {
      const originalEnv = process.env;
      process.env = {
        ...originalEnv,
        STELLAR_NETWORK: 'testnet',
        STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
        STELLAR_NETWORK_PASSPHRASE: 'Public Global Stellar Network ; September 2015',
        BLOCKCHAIN_FEATURES_ENABLED: 'false',
      };

      const errors = validateBlockchainConfig();
      const passphraseError = errors.find((e) => e.field === 'STELLAR_NETWORK_PASSPHRASE');
      expect(passphraseError).toBeDefined();
      expect(passphraseError?.message).toMatch(/does not match/);

      process.env = originalEnv;
    });

    it('should fail when blockchain features are enabled but contract IDs are missing', () => {
      const originalEnv = process.env;
      process.env = {
        ...originalEnv,
        STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
        STELLAR_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
        BLOCKCHAIN_FEATURES_ENABLED: 'true',
        PROPERTY_LISTING_CONTRACT_ID: '',
        BOOKING_CONTRACT_ID: '',
        REVIEW_CONTRACT_ID: '',
        STELLAR_ADMIN_SECRET: '',
      };

      const errors = validateBlockchainConfig();
      expect(errors.length).toBeGreaterThan(0);

      const contractErrors = errors.filter((e) =>
        ['PROPERTY_LISTING_CONTRACT_ID', 'BOOKING_CONTRACT_ID', 'REVIEW_CONTRACT_ID'].includes(e.field)
      );
      expect(contractErrors.length).toBe(3);

      const secretError = errors.find((e) => e.field === 'STELLAR_ADMIN_SECRET');
      expect(secretError).toBeDefined();

      process.env = originalEnv;
    });

    it('should pass when blockchain features are disabled and contracts are not required', () => {
      const originalEnv = process.env;
      process.env = {
        ...originalEnv,
        STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
        STELLAR_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
        BLOCKCHAIN_FEATURES_ENABLED: 'false',
        PROPERTY_LISTING_CONTRACT_ID: '',
        BOOKING_CONTRACT_ID: '',
        REVIEW_CONTRACT_ID: '',
        STELLAR_ADMIN_SECRET: '',
      };

      const errors = validateBlockchainConfig();
      expect(errors).toHaveLength(0);

      process.env = originalEnv;
    });
  });
});
