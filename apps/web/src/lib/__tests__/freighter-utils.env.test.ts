import { describe, it, expect } from 'vitest';
import {
  isUnsupportedWalletEnvironment,
  getUnsupportedEnvironmentMessage,
} from '../freighter-utils';

describe('freighter environment detection (#626)', () => {
  it('flags in-app browsers as unsupported', () => {
    expect(isUnsupportedWalletEnvironment('Mozilla/5.0 Instagram')).toBe(true);
    expect(isUnsupportedWalletEnvironment('FBAN/FBAV')).toBe(true);
  });

  it('flags mobile without freighter bridge as unsupported', () => {
    // jsdom has no freighter global
    expect(
      isUnsupportedWalletEnvironment(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      ),
    ).toBe(true);
  });

  it('allows desktop user agents', () => {
    expect(
      isUnsupportedWalletEnvironment(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0',
      ),
    ).toBe(false);
  });

  it('returns actionable unsupported message', () => {
    const msg = getUnsupportedEnvironmentMessage();
    expect(msg).toMatch(/Freighter/i);
    expect(msg).toMatch(/DEVICE_MATRIX/i);
  });
});
