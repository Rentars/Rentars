import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import PublishReadinessBanner from '../PublishReadinessBanner';

global.fetch = vi.fn();

describe('PublishReadinessBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows ready state when all fields are present', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ ready: true, missingFields: [], imageCount: 2 }),
    });

    render(<PublishReadinessBanner propertyId="prop-1" />);
    await waitFor(() => {
      expect(screen.getByRole('status')).toBeTruthy();
    });
    expect(screen.getByText(/ready to publish/i)).toBeTruthy();
  });

  it('shows missing fields when not ready', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ ready: false, missingFields: ['title', 'images'], imageCount: 0 }),
    });

    render(<PublishReadinessBanner propertyId="prop-2" />);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy();
    });
    expect(screen.getByText(/Property title/i)).toBeTruthy();
    expect(screen.getByText(/At least one photo/i)).toBeTruthy();
  });

  it('calls onGoToStep when a step link is clicked', async () => {
    const onGoToStep = vi.fn();
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ ready: false, missingFields: ['title'], imageCount: 0 }),
    });

    render(<PublishReadinessBanner propertyId="prop-3" onGoToStep={onGoToStep} />);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy();
    });
    screen.getByText(/Property title/i).click();
    expect(onGoToStep).toHaveBeenCalledWith('basic');
  });

  it('renders nothing on fetch error', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'));
    const { container } = render(<PublishReadinessBanner propertyId="prop-4" />);
    await waitFor(() => {
      // Should not show loading anymore
      expect(screen.queryByText(/Checking publish readiness/i)).toBeNull();
    });
    expect(container.firstChild).toBeNull();
  });
});
