import { describe, it, expect, afterEach } from 'vitest';
import { getExpectedNetwork } from '../network-utils';

describe('network-utils', () => {
  const originalNetwork = process.env.NEXT_PUBLIC_STELLAR_NETWORK;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalNetwork === undefined) {
      delete process.env.NEXT_PUBLIC_STELLAR_NETWORK;
    } else {
      process.env.NEXT_PUBLIC_STELLAR_NETWORK = originalNetwork;
    }
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('returns mainnet when NEXT_PUBLIC_STELLAR_NETWORK=mainnet', () => {
    process.env.NEXT_PUBLIC_STELLAR_NETWORK = 'mainnet';
    expect(getExpectedNetwork()).toBe('mainnet');
  });

  it('defaults to testnet in non-production when unset', () => {
    delete process.env.NEXT_PUBLIC_STELLAR_NETWORK;
    process.env.NODE_ENV = 'development';
    expect(getExpectedNetwork()).toBe('testnet');
  });

  it('throws in production when NEXT_PUBLIC_STELLAR_NETWORK is unset', () => {
    delete process.env.NEXT_PUBLIC_STELLAR_NETWORK;
    process.env.NODE_ENV = 'production';
    expect(() => getExpectedNetwork()).toThrow(/NEXT_PUBLIC_STELLAR_NETWORK must be set/);
  });
});
