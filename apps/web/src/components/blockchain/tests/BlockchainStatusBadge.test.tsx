import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import BlockchainStatusBadge from '../BlockchainStatusBadge';
import type { BlockchainStatus } from '@/services/blockchain';

const base: BlockchainStatus = { verified: false, hash: null, lastVerified: null, pending: false };

describe('BlockchainStatusBadge', () => {
  it('renders verified badge with green colour', () => {
    render(<BlockchainStatusBadge status={{ ...base, verified: true }} />);
    const badge = screen.getByText('Verified').closest('div');
    expect(badge).toHaveClass('bg-green-100', 'text-green-700');
  });

  it('renders pending badge with yellow colour', () => {
    render(<BlockchainStatusBadge status={{ ...base, pending: true }} />);
    const badge = screen.getByText('Pending').closest('div');
    expect(badge).toHaveClass('bg-yellow-100', 'text-yellow-700');
  });

  it('renders failed badge with red colour', () => {
    render(<BlockchainStatusBadge status={{ ...base, failed: true }} />);
    const badge = screen.getByText('Failed').closest('div');
    expect(badge).toHaveClass('bg-red-100', 'text-red-700');
  });

  it('renders unverified badge with gray colour when all flags are false', () => {
    render(<BlockchainStatusBadge status={base} />);
    const badge = screen.getByText('Unverified').closest('div');
    expect(badge).toHaveClass('bg-gray-100', 'text-gray-600');
  });

  it('renders unknown badge for an unrecognised status shape', () => {
    // verified is undefined (not false) — simulates a future API field or a
    // status object that bypasses the known boolean flags entirely.
    const unknownStatus = { verified: undefined, hash: null, lastVerified: null, pending: false } as unknown as BlockchainStatus;
    render(<BlockchainStatusBadge status={unknownStatus} />);
    const badge = screen.getByText('Unknown').closest('div');
    expect(badge).toHaveClass('bg-gray-100', 'text-gray-500');
  });

  it('renders unknown badge when status is null at runtime', () => {
    // Simulates a missing API response field reaching the component.
    render(<BlockchainStatusBadge status={null as unknown as BlockchainStatus} />);
    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });
});
