import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useWallet } from '../useWallet';
import * as freighterUtils from '@/lib/freighter-utils';

vi.mock('@/lib/freighter-utils');
vi.mock('@/lib/network-utils', () => ({
  getExpectedNetwork: () => 'testnet',
}));

const ADDR_A = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const ADDR_B = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBK';

describe('useWallet account switching (#620)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.mocked(freighterUtils.isUnsupportedWalletEnvironment).mockReturnValue(false);
    vi.mocked(freighterUtils.getUnsupportedEnvironmentMessage).mockReturnValue('unsupported');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('updates UI when Freighter account changes on focus check', async () => {
    localStorage.setItem('freighter_wallet_connected', 'true');
    localStorage.setItem('freighter_wallet_address', ADDR_A);

    vi.mocked(freighterUtils.getWalletStatus)
      .mockResolvedValueOnce({
        isConnected: true,
        address: ADDR_A,
        network: 'testnet',
        networkMismatch: false,
        isLoading: false,
        error: null,
      })
      .mockResolvedValue({
        isConnected: true,
        address: ADDR_B,
        network: 'testnet',
        networkMismatch: false,
        isLoading: false,
        error: null,
      });

    const { result } = renderHook(() => useWallet());

    await waitFor(() => {
      expect(result.current.state.isLoading).toBe(false);
    });

    expect(result.current.state.address).toBe(ADDR_A);

    await act(async () => {
      await result.current.checkStatus();
    });

    expect(result.current.state.address).toBe(ADDR_B);
    expect(result.current.state.accountChanged).toBe(true);
    expect(result.current.state.previousAddress).toBe(ADDR_A);
  });

  it('assertSigningAddress rejects mismatched account', async () => {
    vi.mocked(freighterUtils.getWalletStatus).mockResolvedValue({
      isConnected: true,
      address: ADDR_B,
      network: 'testnet',
      networkMismatch: false,
      isLoading: false,
      error: null,
    });

    const { result } = renderHook(() => useWallet());

    await waitFor(() => expect(result.current.state.isLoading).toBe(false));

    await expect(result.current.assertSigningAddress(ADDR_A)).rejects.toThrow(
      /account changed/i,
    );
  });

  it('disconnect clears local wallet state', async () => {
    vi.mocked(freighterUtils.connectFreighterWallet).mockResolvedValue(ADDR_A);

    const { result } = renderHook(() => useWallet());

    await waitFor(() => expect(result.current.state.isLoading).toBe(false));

    await act(async () => {
      await result.current.connect();
    });

    expect(localStorage.getItem('freighter_wallet_connected')).toBe('true');
    expect(localStorage.getItem('freighter_wallet_address')).toBe(ADDR_A);

    act(() => {
      result.current.disconnect();
    });

    expect(result.current.state.isConnected).toBe(false);
    expect(result.current.state.address).toBeNull();
    expect(result.current.state.accountChanged).toBe(false);
    expect(localStorage.getItem('freighter_wallet_connected')).toBeNull();
    expect(localStorage.getItem('freighter_wallet_address')).toBeNull();
  });

  it('confirmAccountSwitch binds session to the new address', async () => {
    localStorage.setItem('freighter_wallet_connected', 'true');
    localStorage.setItem('freighter_wallet_address', ADDR_A);

    vi.mocked(freighterUtils.getWalletStatus)
      .mockResolvedValueOnce({
        isConnected: true,
        address: ADDR_A,
        network: 'testnet',
        networkMismatch: false,
        isLoading: false,
        error: null,
      })
      .mockResolvedValue({
        isConnected: true,
        address: ADDR_B,
        network: 'testnet',
        networkMismatch: false,
        isLoading: false,
        error: null,
      });

    const { result } = renderHook(() => useWallet());
    await waitFor(() => expect(result.current.state.isLoading).toBe(false));

    await act(async () => {
      await result.current.checkStatus();
    });

    expect(result.current.state.accountChanged).toBe(true);

    act(() => {
      result.current.confirmAccountSwitch();
    });

    expect(result.current.state.accountChanged).toBe(false);
    expect(localStorage.getItem('freighter_wallet_address')).toBe(ADDR_B);
  });
});
