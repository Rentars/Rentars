import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@/tests/utils/test-utils';
import userEvent from '@testing-library/user-event';
import HostResponseForm from '../HostResponseForm';

describe('HostResponseForm', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const user = userEvent.setup();

  const defaultProps = {
    reviewId: 'review-1',
    onSuccess: vi.fn(),
  };

  beforeEach(() => {
    localStorage.setItem('token', 'test-token');
    fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ host_response: 'Thank you!' }),
      } as Response)
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('renders textarea and submit button', () => {
    render(<HostResponseForm {...defaultProps} />);
    expect(screen.getByPlaceholderText(/write your response/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /post response/i })).toBeInTheDocument();
  });

  it('shows error when submitting empty input', async () => {
    render(<HostResponseForm {...defaultProps} />);
    await user.click(screen.getByRole('button', { name: /post response/i }));
    expect(screen.getByText('Response cannot be empty')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends trimmed text in the request body when input has surrounding whitespace', async () => {
    render(<HostResponseForm {...defaultProps} />);

    const textarea = screen.getByPlaceholderText(/write your response/i);
    await user.type(textarea, '  Thank you for the feedback!  ');

    await user.click(screen.getByRole('button', { name: /post response/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(`/api/v1/reviews/review-1/response`),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ response: 'Thank you for the feedback!' }),
        })
      );
    });
  });

  it('preserves the original typed text in the field while submission is in flight', async () => {
    // Hang the request so we can inspect mid-flight state
    fetchMock.mockImplementationOnce(() => new Promise(() => {}));

    render(<HostResponseForm {...defaultProps} />);

    const textarea = screen.getByPlaceholderText(/write your response/i);
    await user.type(textarea, '  Great stay!  ');

    await user.click(screen.getByRole('button', { name: /post response/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /submitting/i })).toBeDisabled();
    });

    // Original value (with whitespace) still in the field
    expect(textarea).toHaveValue('  Great stay!  ');
  });

  it('calls onSuccess with the response text and clears the field after success', async () => {
    render(<HostResponseForm {...defaultProps} />);

    const textarea = screen.getByPlaceholderText(/write your response/i);
    await user.type(textarea, 'Thank you!');

    await user.click(screen.getByRole('button', { name: /post response/i }));

    await waitFor(() => {
      expect(defaultProps.onSuccess).toHaveBeenCalledWith('Thank you!');
      expect(textarea).toHaveValue('');
    });
  });

  it('shows error message and preserves text when request fails', async () => {
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve({
        ok: false,
        json: () => Promise.resolve({ error: 'Not authorized' }),
      } as Response)
    );

    render(<HostResponseForm {...defaultProps} />);

    const textarea = screen.getByPlaceholderText(/write your response/i);
    await user.type(textarea, 'My response');

    await user.click(screen.getByRole('button', { name: /post response/i }));

    await waitFor(() => {
      expect(screen.getByText('Not authorized')).toBeInTheDocument();
    });

    // Field is NOT cleared on failure
    expect(textarea).toHaveValue('My response');
  });

  it('rejects blank-after-trim input', async () => {
    render(<HostResponseForm {...defaultProps} />);

    const textarea = screen.getByPlaceholderText(/write your response/i);
    await user.type(textarea, '   ');

    await user.click(screen.getByRole('button', { name: /post response/i }));

    expect(screen.getByText('Response cannot be empty')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
