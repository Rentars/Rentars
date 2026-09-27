import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolveContract,
  resolveContractDualRead,
  preferredGeneration,
  assertContractVersionSupported,
  CONTRACT_VERSION_MIN,
} from '../versions';

describe('contract versions dual-read (#625)', () => {
  const env = process.env;

  beforeEach(() => {
    process.env = { ...env };
    delete process.env.NEXT_PUBLIC_BOOKING_CONTRACT_ID;
    delete process.env.NEXT_PUBLIC_BOOKING_CONTRACT_ID_LEGACY;
    delete process.env.NEXT_PUBLIC_CONTRACT_GENERATION;
  });

  afterEach(() => {
    process.env = env;
  });

  it('defaults preferred generation to current', () => {
    expect(preferredGeneration()).toBe('current');
  });

  it('resolves current booking contract', () => {
    process.env.NEXT_PUBLIC_BOOKING_CONTRACT_ID = 'CNEW';
    const endpoint = resolveContract('booking');
    expect(endpoint?.address).toBe('CNEW');
    expect(endpoint?.generation).toBe('current');
    expect(endpoint?.version).toBe(CONTRACT_VERSION_MIN);
  });

  it('dual-read returns both generations', () => {
    process.env.NEXT_PUBLIC_BOOKING_CONTRACT_ID = 'CNEW';
    process.env.NEXT_PUBLIC_BOOKING_CONTRACT_ID_LEGACY = 'COLD';
    const list = resolveContractDualRead('booking');
    expect(list).toHaveLength(2);
    expect(list.map((e) => e.generation)).toEqual(['current', 'legacy']);
  });

  it('assertContractVersionSupported rejects stale versions', () => {
    expect(() => assertContractVersionSupported(CONTRACT_VERSION_MIN)).not.toThrow();
    expect(() => assertContractVersionSupported(CONTRACT_VERSION_MIN - 1)).toThrow(/below minimum/);
  });
});
