import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@/tests/utils/test-utils';
import userEvent from '@testing-library/user-event';
import ReviewForm from '../ReviewForm';

describe('ReviewForm', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const user = userEvent.setup();

  const defaultProps = {
    bookingId: 'booking-1',
    targetId: 'user-1',
    propertyId: 'prop-1',
    onSuccess: vi.fn(),
  };

  beforeEach(() => {
    localStorage.setItem('token', 'test-token');
    fetchMock = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'review-1' }) } as Response)
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('renders form elements', () => {
    render(<ReviewForm {...defaultProps} />);
    expect(screen.getByText('Leave a Review')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/share your experience/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /submit review/i })).toBeInTheDocument();
  });

  it('shows error when submitting without a rating', async () => {
    render(<ReviewForm {...defaultProps} />);
    await user.click(screen.getByRole('button', { name: /submit review/i }));
    expect(screen.getByText('Please select a rating')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('submits review with rating and comment', async () => {
    render(<ReviewForm {...defaultProps} />);

    // Click 4th star to set rating to 4
    const stars = screen.getAllByRole('button').filter((b) => b.getAttribute('type') === 'button');
    await user.click(stars[3]); // 4th star

    const textarea = screen.getByPlaceholderText(/share your experience/i);
    await user.type(textarea, 'Great place!');

    await user.click(screen.getByRole('button', { name: /submit review/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/reviews'),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"rating":4'),
        })
      );
    });

    await waitFor(() => {
      expect(defaultProps.onSuccess).toHaveBeenCalled();
    });
  });

  it('shows error when API call fails', async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve({
        ok: false,
        json: () => Promise.resolve({ error: 'Review already submitted' }),
      } as Response)
    );

    render(<ReviewForm {...defaultProps} />);

    const stars = screen.getAllByRole('button');
    await user.click(stars[2]);

    await user.click(screen.getByRole('button', { name: /submit review/i }));

    await waitFor(() => {
      expect(screen.getByText('Review already submitted')).toBeInTheDocument();
    });
  });

  it('disables submit button while submitting', async () => {
    // Make the fetch hang
    fetchMock.mockImplementationOnce(() => new Promise(() => {}));

    render(<ReviewForm {...defaultProps} />);

    const stars = screen.getAllByRole('button');
    await user.click(stars[4]); // 5 stars

    await user.click(screen.getByRole('button', { name: /submit review/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /submitting/i })).toBeDisabled();
    });
  });

  it('sends exactly one request when submit is clicked twice while fetch is pending', async () => {
    // First call hangs so the second click arrives while submitting is true
    let resolveFetch!: (v: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((res) => { resolveFetch = res; })
    );

    render(<ReviewForm {...defaultProps} />);

    const stars = screen.getAllByRole('button').filter((b) => b.getAttribute('type') === 'button');
    await user.click(stars[3]); // 4 stars

    const submitBtn = screen.getByRole('button', { name: /submit review/i });

    // First click — starts the request
    await user.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /submitting/i })).toBeDisabled();
    });

    // Second click while in-flight — should be swallowed by the guard
    await user.click(screen.getByRole('button', { name: /submitting/i }));

    // Resolve the single pending fetch
    resolveFetch({
      ok: true,
      json: () => Promise.resolve({ id: 'review-1' }),
    } as Response);

    await waitFor(() => {
      expect(defaultProps.onSuccess).toHaveBeenCalledTimes(1);
    });

    // Only one network request should ever have been made
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-enables the submit button after a failed submission', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: 'Server error' }),
    } as Response);

    render(<ReviewForm {...defaultProps} />);

    const stars = screen.getAllByRole('button').filter((b) => b.getAttribute('type') === 'button');
    await user.click(stars[2]); // 3 stars

    await user.click(screen.getByRole('button', { name: /submit review/i }));

    await waitFor(() => {
      expect(screen.getByText('Server error')).toBeInTheDocument();
    });

    // Button must be re-enabled so the user can try again
    expect(screen.getByRole('button', { name: /submit review/i })).not.toBeDisabled();
  });

  it('resets form after successful submission', async () => {
    render(<ReviewForm {...defaultProps} />);

    const stars = screen.getAllByRole('button');
    await user.click(stars[4]);

    const textarea = screen.getByPlaceholderText(/share your experience/i);
    await user.type(textarea, 'Amazing!');

    await user.click(screen.getByRole('button', { name: /submit review/i }));

    await waitFor(() => {
      expect(defaultProps.onSuccess).toHaveBeenCalled();
      expect(textarea).toHaveValue('');
    });
  });
});
