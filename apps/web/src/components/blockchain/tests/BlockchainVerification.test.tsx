import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import BlockchainVerification from '../BlockchainVerification';
import * as blockchainService from '@/services/blockchain';

vi.mock('@/services/blockchain');

// Mirrors the constant in the component. Kept in sync intentionally —
// if the component constant changes the timed-out tests will catch it.
const MAX_POLL_ATTEMPTS = 60;

const mockGetStatus = vi.mocked(blockchainService.getBlockchainStatus);
const mockVerify = vi.mocked(blockchainService.verifyProperty);

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

// ─── Tests that do NOT need timer control ────────────────────────────────────
// Real timers are active here so waitFor's internal polling works normally.

describe('BlockchainVerification', () => {
  it('shows verified state with green badge and hash', async () => {
    mockGetStatus.mockResolvedValue({
      verified: true,
      hash: '0xabc123',
      lastVerified: '2024-01-01T00:00:00Z',
      pending: false,
    });

    render(<BlockchainVerification propertyId="prop-1" />);

    await waitFor(() => expect(screen.getByText('Blockchain Verified')).toBeInTheDocument());
    expect(screen.getByText('0xabc123')).toBeInTheDocument();
  });

  it('shows unverified state with warning', async () => {
    mockGetStatus.mockResolvedValue({ verified: false, hash: null, lastVerified: null, pending: false });

    render(<BlockchainVerification propertyId="prop-1" />);

    await waitFor(() => expect(screen.getByText('Not Verified')).toBeInTheDocument());
    expect(screen.getByText('Verify on Blockchain')).toBeInTheDocument();
  });

  it('shows pending state', async () => {
    mockGetStatus.mockResolvedValue({ verified: false, hash: null, lastVerified: null, pending: true });

    render(<BlockchainVerification propertyId="prop-1" />);

    await waitFor(() => expect(screen.getByText('Verification Pending')).toBeInTheDocument());
    expect(screen.getByText('Waiting for blockchain confirmation...')).toBeInTheDocument();
  });

  it('"Verify on Blockchain" button calls verification API', async () => {
    mockGetStatus.mockResolvedValue({ verified: false, hash: null, lastVerified: null, pending: false });
    mockVerify.mockResolvedValue({ verified: true, hash: '0xnew', lastVerified: null, pending: false });

    render(<BlockchainVerification propertyId="prop-1" />);

    await waitFor(() => screen.getByText('Verify on Blockchain'));
    fireEvent.click(screen.getByText('Verify on Blockchain'));

    await waitFor(() => expect(mockVerify).toHaveBeenCalledWith('prop-1'));
    expect(screen.getByText('Blockchain Verified')).toBeInTheDocument();
  });

  it('shows error state on API failure', async () => {
    mockGetStatus.mockRejectedValue(new Error('Network error'));

    render(<BlockchainVerification propertyId="prop-1" />);

    await waitFor(() => expect(screen.getByText('Network error')).toBeInTheDocument());
  });

  it('hash copy-to-clipboard works', async () => {
    mockGetStatus.mockResolvedValue({
      verified: true,
      hash: '0xabc123',
      lastVerified: null,
      pending: false,
    });

    render(<BlockchainVerification propertyId="prop-1" />);

    await waitFor(() => screen.getByTitle('Copy hash'));
    fireEvent.click(screen.getByTitle('Copy hash'));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('0xabc123');
  });

  // ─── Tests that control the polling clock ──────────────────────────────────
  // Fake timers are scoped to this nested describe so they never leak into the
  // real-timer tests above. waitFor calls inside these tests are preceded by
  // manual timer advances that flush the setTimeout-based poll loop.

  describe('polling behaviour (fake timers)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('stops polling and shows timed-out UI after MAX_POLL_ATTEMPTS of always-pending responses', async () => {
      // Every call returns pending — the network never resolves to a terminal state.
      mockGetStatus.mockResolvedValue({ verified: false, hash: null, lastVerified: null, pending: true });

      render(<BlockchainVerification propertyId="prop-1" />);

      // Drain the initial loadStatus call so the component enters the pending state.
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      await waitFor(() => expect(screen.getByText('Verification Pending')).toBeInTheDocument());

      // Advance the clock MAX_POLL_ATTEMPTS times, flushing each setTimeout and
      // its async callback before triggering the next one.
      for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
        await act(async () => {
          vi.advanceTimersByTime(5000);
          // Drain microtasks so the async loadStatus callback resolves.
          await Promise.resolve();
          await Promise.resolve();
        });
      }

      // After exhausting all attempts the component must show the timed-out UI,
      // not remain in the perpetual pending state.
      await act(async () => { await Promise.resolve(); });
      expect(screen.getByText('Verification Timed Out')).toBeInTheDocument();

      // The actionable "Check again" button must be present so the user can retry.
      expect(screen.getByText('Check again')).toBeInTheDocument();

      // Pending copy must no longer be shown.
      expect(screen.queryByText('Verification Pending')).not.toBeInTheDocument();
      expect(screen.queryByText('Waiting for blockchain confirmation...')).not.toBeInTheDocument();

      // No further fetches should be triggered after the cap is hit.
      const callCountAfterTimeout = mockGetStatus.mock.calls.length;
      await act(async () => {
        vi.advanceTimersByTime(5000);
        await Promise.resolve();
      });
      expect(mockGetStatus.mock.calls.length).toBe(callCountAfterTimeout);
    });

    it('stops polling immediately when a success response arrives mid-poll', async () => {
      // First call: pending. Second call: terminal success.
      mockGetStatus
        .mockResolvedValueOnce({ verified: false, hash: null, lastVerified: null, pending: true })
        .mockResolvedValueOnce({ verified: true, hash: '0xdone', lastVerified: null, pending: false });

      render(<BlockchainVerification propertyId="prop-1" />);

      // Drain the initial load.
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      await waitFor(() => expect(screen.getByText('Verification Pending')).toBeInTheDocument());

      // Trigger one poll interval.
      await act(async () => {
        vi.advanceTimersByTime(5000);
        await Promise.resolve();
        await Promise.resolve();
      });

      // Drain state updates from the resolved poll.
      await act(async () => { await Promise.resolve(); });

      expect(screen.getByText('Blockchain Verified')).toBeInTheDocument();

      // Only 2 calls total: initial load + one poll.
      expect(mockGetStatus).toHaveBeenCalledTimes(2);

      // Advancing further must not produce additional calls.
      await act(async () => {
        vi.advanceTimersByTime(5000);
        await Promise.resolve();
      });
      expect(mockGetStatus).toHaveBeenCalledTimes(2);
    });

    it('"Check again" button resets timed-out state and resumes polling', async () => {
      const pendingResponse = { verified: false, hash: null, lastVerified: null, pending: true };
      const successResponse = { verified: true, hash: '0xretry', lastVerified: null, pending: false };

      mockGetStatus.mockResolvedValue(pendingResponse);

      render(<BlockchainVerification propertyId="prop-1" />);

      // Drain the initial load.
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      await waitFor(() => expect(screen.getByText('Verification Pending')).toBeInTheDocument());

      // Exhaust the cap.
      for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
        await act(async () => {
          vi.advanceTimersByTime(5000);
          await Promise.resolve();
          await Promise.resolve();
        });
      }

      await act(async () => { await Promise.resolve(); });
      expect(screen.getByText('Verification Timed Out')).toBeInTheDocument();

      // Switch the mock to return success, then click "Check again".
      mockGetStatus.mockResolvedValue(successResponse);

      fireEvent.click(screen.getByText('Check again'));

      // Drain the loadStatus triggered by "Check again".
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      expect(screen.getByText('Blockchain Verified')).toBeInTheDocument();
    });
  });
});
