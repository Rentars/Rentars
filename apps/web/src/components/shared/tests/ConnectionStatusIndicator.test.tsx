/**
 * Tests for the connection status indicator (issue #646).
 *
 * The indicator is the user-facing half of the recovery feature: it must
 * distinguish "live", "catching up" and "not connected" so a half-synced
 * list is never presented as current.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ConnectionStatusIndicator } from '../ConnectionStatusIndicator';

describe('ConnectionStatusIndicator', () => {
  it('renders the live state', () => {
    render(<ConnectionStatusIndicator status="connected" showLabel />);

    expect(screen.getByText('Live')).toBeInTheDocument();
    expect(
      screen.getByRole('status', { name: /real-time updates connected/i })
    ).toBeInTheDocument();
  });

  it('renders the stale state while catching up after a reconnect', () => {
    render(<ConnectionStatusIndicator status="stale" showLabel />);

    expect(screen.getByText('Syncing…')).toBeInTheDocument();
    expect(
      screen.getByRole('status', { name: /catching up on missed updates/i })
    ).toBeInTheDocument();
  });

  it('renders the reconnecting state', () => {
    render(<ConnectionStatusIndicator status="reconnecting" showLabel />);

    expect(screen.getByText('Reconnecting…')).toBeInTheDocument();
  });

  it('renders the disconnected state', () => {
    render(<ConnectionStatusIndicator status="disconnected" showLabel />);

    expect(screen.getByText('Offline')).toBeInTheDocument();
  });

  it('hides the label when showLabel is false', () => {
    render(<ConnectionStatusIndicator status="connected" />);

    expect(screen.queryByText('Live')).not.toBeInTheDocument();
    // The accessible name is still announced.
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('shows the attempt counter while reconnecting', () => {
    render(
      <ConnectionStatusIndicator
        status="reconnecting"
        showLabel
        retryAttempt={3}
        retriesRemaining={5}
      />
    );

    expect(screen.getByText(/Reconnecting… \(3\/8\)/)).toBeInTheDocument();
  });

  it('omits the attempt counter before the first retry', () => {
    render(<ConnectionStatusIndicator status="reconnecting" showLabel retryAttempt={0} />);

    expect(screen.getByText('Reconnecting…')).toBeInTheDocument();
  });

  it('omits the attempt counter for non-reconnecting states', () => {
    render(
      <ConnectionStatusIndicator
        status="connected"
        showLabel
        retryAttempt={4}
        retriesRemaining={4}
      />
    );

    expect(screen.getByText('Live')).toBeInTheDocument();
  });

  it('shows the attempt count without a total when remaining is unknown', () => {
    render(<ConnectionStatusIndicator status="reconnecting" showLabel retryAttempt={2} />);

    expect(screen.getByText(/Reconnecting… \(2\)/)).toBeInTheDocument();
  });

  it('applies a custom class name', () => {
    const { container } = render(
      <ConnectionStatusIndicator status="connected" className="my-custom" />
    );

    expect(container.querySelector('.my-custom')).not.toBeNull();
  });
});
