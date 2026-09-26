import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@/tests/utils/test-utils';
import userEvent from '@testing-library/user-event';
import ReviewList, { ReviewItem } from '../ReviewList';

const REVIEWS: ReviewItem[] = [
  {
    id: 'review-1',
    reviewer_id: 'user-2',
    rating: 4,
    comment: 'Great stay!',
    reviewer_name: 'Alice',
    created_at: '2024-01-15T00:00:00.000Z',
  },
];

describe('ReviewList', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const user = userEvent.setup();

  beforeEach(() => {
    localStorage.setItem('token', 'test-token');
    fetchMock = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response)
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('renders reviews and shows empty state when list is empty', () => {
    const { rerender } = render(
      <ReviewList reviews={REVIEWS} currentUserId="user-1" />
    );
    expect(screen.getByText('Great stay!')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();

    rerender(<ReviewList reviews={[]} />);
    expect(screen.getByText(/no reviews yet/i)).toBeInTheDocument();
  });

  it('shows the Report button for reviews the current user did not write', () => {
    render(<ReviewList reviews={REVIEWS} currentUserId="user-1" />);
    expect(screen.getByRole('button', { name: /report/i })).toBeInTheDocument();
  });

  it('hides the Report button when the current user is the reviewer', () => {
    render(<ReviewList reviews={REVIEWS} currentUserId="user-2" />);
    expect(screen.queryByRole('button', { name: /report/i })).not.toBeInTheDocument();
  });

  it('marks review as reported and disables button on successful flag', async () => {
    render(<ReviewList reviews={REVIEWS} currentUserId="user-1" />);

    await user.click(screen.getByRole('button', { name: /report/i }));

    await waitFor(() => {
      expect(screen.getByText('Reported')).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: /reported/i })).toBeDisabled();
    // No error alert should be present
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows an accessible role="alert" announcement when the flag request fails', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: 'Forbidden' }),
    } as Response);

    render(<ReviewList reviews={REVIEWS} currentUserId="user-1" />);

    await user.click(screen.getByRole('button', { name: /report/i }));

    await waitFor(() => {
      const alert = screen.getByRole('alert');
      expect(alert).toBeInTheDocument();
      expect(alert).toHaveTextContent(/failed to report review/i);
    });
  });

  it('does not expose internal error details in the flag failure message', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Network stack internal error details'));

    render(<ReviewList reviews={REVIEWS} currentUserId="user-1" />);

    await user.click(screen.getByRole('button', { name: /report/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    // Internal error detail must NOT leak into the UI
    expect(screen.queryByText(/network stack internal error details/i)).not.toBeInTheDocument();
  });

  it('clears a previous flag error when a new flag attempt begins', async () => {
    // First attempt fails
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({}),
    } as Response);

    const reviews: ReviewItem[] = [
      { ...REVIEWS[0], id: 'review-1' },
      { id: 'review-2', reviewer_id: 'user-3', rating: 3, comment: 'OK', reviewer_name: 'Bob' },
    ];

    render(<ReviewList reviews={reviews} currentUserId="user-1" />);

    const [firstBtn] = screen.getAllByRole('button', { name: /report/i });
    await user.click(firstBtn);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    // Second attempt on a different review — error should be cleared while in-flight
    fetchMock.mockImplementationOnce(() => new Promise(() => {})); // hang
    const [, secondBtn] = screen.getAllByRole('button', { name: /report/i });
    await user.click(secondBtn);

    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });
});
