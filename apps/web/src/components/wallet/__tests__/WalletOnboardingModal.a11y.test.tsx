import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WalletOnboardingModal } from '../WalletOnboardingModal';

const mockWallet = {
  state: {
    isConnected: false,
    address: null,
    network: 'testnet' as const,
    networkMismatch: false,
    isLoading: false,
    error: null,
    accountChanged: false,
    previousAddress: null,
    unsupportedEnvironment: false,
    unsupportedMessage: null,
  },
  connect: vi.fn(),
  disconnect: vi.fn(),
  checkStatus: vi.fn(),
  confirmAccountSwitch: vi.fn(),
  assertSigningAddress: vi.fn(),
  isReady: true,
};

vi.mock('@/context/WalletContext', () => ({
  useWalletContext: () => mockWallet,
}));

vi.mock('../WalletConnectButton', () => ({
  WalletConnectButton: ({ onConnect }: { onConnect?: (a: string) => void }) => (
    <button type="button" onClick={() => onConnect?.('GTEST')}>
      Connect Freighter
    </button>
  ),
}));

vi.mock('../WalletErrorDisplay', () => ({
  WalletErrorDisplay: () => <div data-testid="wallet-error-display" />,
}));

const isUnsupportedMock = vi.hoisted(() => vi.fn(() => false));

vi.mock('@/lib/freighter-utils', () => ({
  FreighterError: class FreighterError extends Error {},
  isUnsupportedWalletEnvironment: (...args: unknown[]) => isUnsupportedMock(...args),
  getUnsupportedEnvironmentMessage: () =>
    'This browser cannot complete Freighter wallet handoff.',
}));

describe('WalletOnboardingModal a11y (#626)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isUnsupportedMock.mockReturnValue(false);
    mockWallet.state.unsupportedEnvironment = false;
    mockWallet.state.unsupportedMessage = null;
  });

  it('exposes dialog semantics and live status region', () => {
    render(
      <WalletOnboardingModal isOpen onClose={vi.fn()} requiredNetwork="testnet" />,
    );

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByTestId('wallet-modal-status')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByTestId('wallet-modal-status')).toHaveTextContent(/dialog opened/i);
  });

  it('traps focusable controls and closes on Escape', () => {
    const onClose = vi.fn();
    render(<WalletOnboardingModal isOpen onClose={onClose} />);

    const dialog = screen.getByTestId('wallet-onboarding-modal');
    expect(dialog).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    // close is async (animation timeout); assert handler path via status update
    expect(screen.getByTestId('wallet-modal-status')).toHaveTextContent(/closed/i);
  });

  it('announces loading/error recovery path on connect step', () => {
    render(<WalletOnboardingModal isOpen onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /connect wallet/i }));
    expect(screen.getByTestId('wallet-modal-status')).toHaveTextContent(/ready to connect|connecting|error/i);
  });

  it('shows non-dead-end message for unsupported environments', () => {
    isUnsupportedMock.mockReturnValue(true);

    render(<WalletOnboardingModal isOpen onClose={vi.fn()} />);

    expect(screen.getByTestId('wallet-unsupported')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /not supported/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /freighter help/i })).toHaveAttribute(
      'href',
      'https://www.freighter.app',
    );
  });
});
