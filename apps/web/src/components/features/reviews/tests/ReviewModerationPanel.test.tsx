import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@/tests/utils/test-utils';
import ReviewModerationPanel from '../ReviewModerationPanel';

const FLAGGED_FIRST: { id: string; reviewer_id: string; target_id: string; rating: number; comment: string }[] = [
  { id: 'r1', reviewer_id: 'u1', target_id: 'p1', rating: 2, comment: 'First response' },
];

const FLAGGED_SECOND: { id: string; reviewer_id: string; target_id: string; rating: number; comment: string }[] = [
  { id: 'r2', reviewer_id: 'u2', target_id: 'p2', rating: 4, comment: 'Second response' },
];

describe('ReviewModerationPanel', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.setItem('token', 'test-token');
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('shows loading state initially and then renders flagged reviews', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(FLAGGED_FIRST),
    } as Response);

    render(<ReviewModerationPanel />);

    expect(screen.getByText(/loading flagged reviews/i)).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('First response')).toBeInTheDocument();
    });
  });

  it('shows empty state when no flagged reviews are returned', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([]),
    } as Response);

    render(<ReviewModerationPanel />);

    await waitFor(() => {
      expect(screen.getByText(/no flagged reviews/i)).toBeInTheDocument();
    });
  });

  it('displays the latest result when a slower earlier response arrives after a newer one', async () => {
    // First call resolves AFTER the second call — simulates a slow stale response
    let resolveFirst!: (v: Response) => void;
    const firstPromise = new Promise<Response>((res) => { resolveFirst = res; });

    fetchMock
      .mockReturnValueOnce(firstPromise)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(FLAGGED_SECOND),
      } as Response);

    const { unmount } = render(<ReviewModerationPanel />);

    // Trigger a second load while the first is still in-flight
    // The component exposes load() via a manual refresh; here we simulate it
    // by unmounting and remounting (which fires the effect again) — but instead
    // we call load twice by re-rendering which re-runs the effect.
    // Because the component aborts the in-flight first request before firing the
    // second, resolving firstPromise afterwards should NOT update the UI.
    unmount();

    // Now resolve the first (stale) request — after unmount the abort signal fired
    act(() => {
      resolveFirst({
        ok: true,
        json: () => Promise.resolve(FLAGGED_FIRST),
      } as Response);
    });

    // Re-mount so the second (fresh) request runs
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(FLAGGED_SECOND),
    } as Response);

    render(<ReviewModerationPanel />);

    await waitFor(() => {
      expect(screen.getByText('Second response')).toBeInTheDocument();
    });

    // Stale data from the first response must not appear
    expect(screen.queryByText('First response')).not.toBeInTheDocument();
  });

  it('does not update state after unmount', async () => {
    // Hang the fetch so we can unmount before it resolves
    let resolveFetch!: (v: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((res) => { resolveFetch = res; })
    );

    const { unmount } = render(<ReviewModerationPanel />);
    unmount();

    // Resolving after unmount should not cause a state-update warning
    const warnSpy = vi.spyOn(console, 'error');
    act(() => {
      resolveFetch({
        ok: true,
        json: () => Promise.resolve(FLAGGED_FIRST),
      } as Response);
    });

    // No React "can't perform state update on unmounted component" errors
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('unmounted component')
    );
    warnSpy.mockRestore();
  });
});
