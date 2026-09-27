/**
 * Unit tests for contract version / ABI compatibility registry.
 */

import { describe, it, expect, afterEach } from 'bun:test';
import { Networks } from '@stellar/stellar-sdk';
import {
  getPublicContractVersions,
  loadRegistry,
  validateAgainstRegistry,
  type ContractRegistry,
} from '../../src/blockchain/registry.js';

const TESTNET_PROPERTY = 'CDZVXPNK4JGPJD3DYLZX5JBIHGRV5P4SUX7G7MZ7CZTGM7BJS2CZ4P3';
const TESTNET_BOOKING = 'CA3D5KRYM6CB7OWQ6TWYRRSSZ6CCZ7D3E6K4F7C7LXZ4R5X4OVX5S';
const TESTNET_REVIEW = 'CCW67TSZV3SS5YPTS5FG7O2MG6R7WBBNDVQSZRC3Y5ZRBJY3SUKSDZ';

function testnetRegistry(overrides?: Partial<ContractRegistry['contracts'][0]>): ContractRegistry {
  const base = loadRegistry();
  const entry = base.contracts.find(
    (c) => c.network === 'testnet' && c.contractKey === 'booking',
  )!;
  const merged = { ...entry, ...overrides };
  return {
    ...base,
    contracts: base.contracts.map((c) =>
      c.network === 'testnet' && c.contractKey === 'booking' ? merged : c,
    ),
  };
}

describe('contract registry', () => {
  const originalAppVersion = process.env.APP_VERSION;

  afterEach(() => {
    if (originalAppVersion === undefined) delete process.env.APP_VERSION;
    else process.env.APP_VERSION = originalAppVersion;
  });

  describe('loadRegistry', () => {
    it('loads the committed registry with testnet entries', () => {
      const registry = loadRegistry();
      const testnetKeys = registry.contracts
        .filter((c) => c.network === 'testnet')
        .map((c) => c.contractKey);
      expect(testnetKeys.sort()).toEqual(['booking', 'property-listing', 'review']);
    });
  });

  describe('validateAgainstRegistry', () => {
    it('skips validation when blockchain features are disabled', () => {
      const errors = validateAgainstRegistry({
        blockchainFeaturesEnabled: false,
        networkPassphrase: Networks.TESTNET,
        stellarNetwork: 'testnet',
        contractIds: {
          'property-listing': 'CUNKNOWN',
          booking: 'CUNKNOWN',
          review: 'CUNKNOWN',
        },
      });
      expect(errors).toHaveLength(0);
    });

    it('passes when configured IDs match the testnet registry', () => {
      process.env.APP_VERSION = '1.0.0';
      const errors = validateAgainstRegistry({
        blockchainFeaturesEnabled: true,
        networkPassphrase: Networks.TESTNET,
        stellarNetwork: 'testnet',
        appVersion: '1.0.0',
        contractIds: {
          'property-listing': TESTNET_PROPERTY,
          booking: TESTNET_BOOKING,
          review: TESTNET_REVIEW,
        },
      });
      expect(errors).toHaveLength(0);
    });

    it('fails when a contract ID is not registered', () => {
      const errors = validateAgainstRegistry({
        blockchainFeaturesEnabled: true,
        networkPassphrase: Networks.TESTNET,
        stellarNetwork: 'testnet',
        appVersion: '1.0.0',
        contractIds: {
          'property-listing': TESTNET_PROPERTY,
          booking: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
          review: TESTNET_REVIEW,
        },
      });
      const bookingError = errors.find((e) => e.field === 'BOOKING_CONTRACT_ID');
      expect(bookingError).toBeDefined();
      expect(bookingError?.message).toContain('not registered');
    });

    it('allows configured IDs listed as upgrade candidates', () => {
      const previousBookingId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
      const registry = testnetRegistry({
        allowedUpgradeContractIds: [previousBookingId],
      });

      const errors = validateAgainstRegistry({
        blockchainFeaturesEnabled: true,
        networkPassphrase: Networks.TESTNET,
        stellarNetwork: 'testnet',
        appVersion: '1.0.0',
        registry,
        contractIds: {
          'property-listing': TESTNET_PROPERTY,
          booking: previousBookingId,
          review: TESTNET_REVIEW,
        },
      });
      expect(errors).toHaveLength(0);
    });

    it('fails when app version is not compatible', () => {
      const errors = validateAgainstRegistry({
        blockchainFeaturesEnabled: true,
        networkPassphrase: Networks.TESTNET,
        stellarNetwork: 'testnet',
        appVersion: '99.0.0',
        contractIds: {
          'property-listing': TESTNET_PROPERTY,
          booking: TESTNET_BOOKING,
          review: TESTNET_REVIEW,
        },
      });
      const versionError = errors.find((e) => e.field === 'APP_VERSION');
      expect(versionError).toBeDefined();
    });
  });

  describe('getPublicContractVersions', () => {
    it('returns non-sensitive fields for the current testnet', () => {
      const versions = getPublicContractVersions({
        networkPassphrase: Networks.TESTNET,
        stellarNetwork: 'testnet',
      });
      expect(versions.length).toBe(3);
      for (const row of versions) {
        expect(row).toHaveProperty('contractKey');
        expect(row).toHaveProperty('abiVersion');
        expect(row).toHaveProperty('wasmHashPrefix');
        expect(row).not.toHaveProperty('contractId');
        expect(row.wasmHashPrefix).toContain('…');
      }
    });
  });
});
