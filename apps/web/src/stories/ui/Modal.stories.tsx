/**
 * Stories for the Modal, ModalHeader, ModalContent, and ModalFooter
 * components.
 *
 * Covers:
 *  - Default / closed / open states
 *  - Keyboard interactions: Escape to close, Tab / Shift+Tab focus trap
 *  - Backdrop click to close
 *  - Responsive sizing
 *  - Long (scrollable) content
 *  - Danger / confirmation variants
 *  - A11y — role="dialog", aria-modal, aria-labelledby, close-button aria-label
 */
import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { Modal, ModalHeader, ModalContent, ModalFooter } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';

const meta: Meta<typeof Modal> = {
  title: 'UI/Modal',
  component: Modal,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component: `
A fully accessible modal dialog built without any third-party portal library.

**Keyboard behaviour**
| Key | Action |
|---|---|
| \`Tab\` | Move focus forward through interactive elements inside the modal |
| \`Shift + Tab\` | Move focus backward — wraps from first to last element |
| \`Escape\` | Close the modal and return focus to the trigger |

**ARIA attributes**
- \`role="dialog"\` on the container element
- \`aria-modal="true"\` to suppress background content in AT virtual buffers
- \`aria-labelledby="modal-title"\` linked to the \`<h2>\` rendered by \`ModalHeader\`
- \`aria-label="Close modal"\` on the close button

**Usage constraints**
- Always provide a visible \`title\` via \`ModalHeader\` — it is the accessible name.
- Pair every open trigger with an \`onOpenChange\` handler.
- The scroll-lock (\`overflow: hidden\`) is applied to \`document.body\` while the modal is open and cleaned up on unmount.
        `,
      },
    },
  },
};
export default meta;

type Story = StoryObj<typeof Modal>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ControlledModal({
  defaultOpen = false,
  title = 'Modal Dialog',
  children,
  variant = 'default',
}: {
  defaultOpen?: boolean;
  title?: string;
  children?: React.ReactNode;
  variant?: 'default' | 'danger';
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <>
      <Button
        variant={variant === 'danger' ? 'destructive' : 'default'}
        onClick={() => setOpen(true)}
      >
        Open Modal
      </Button>
      <Modal open={open} onOpenChange={setOpen} title={title}>
        <ModalHeader title={title} onClose={() => setOpen(false)} />
        {children ?? (
          <ModalContent>
            <p className="text-sm text-muted-foreground">Modal body content goes here.</p>
          </ModalContent>
        )}
      </Modal>
    </>
  );
}

// ─── States ───────────────────────────────────────────────────────────────────

/** Default open state — what the user sees immediately after triggering. */
export const Default: Story = {
  render: () => (
    <ControlledModal defaultOpen title="Booking Confirmation">
      <ModalContent>
        <p className="text-sm text-muted-foreground">
          Confirm your booking for <strong>Beachside Villa</strong> from Jan 10 – Jan 15.
        </p>
      </ModalContent>
      <ModalFooter>
        <Button variant="outline" className="flex-1">
          Cancel
        </Button>
        <Button className="flex-1">Confirm Booking</Button>
      </ModalFooter>
    </ControlledModal>
  ),
};

/** Closed state — the trigger button is shown, modal hidden until clicked. */
export const Closed: Story = {
  render: () => <ControlledModal defaultOpen={false} title="Confirmation" />,
  parameters: {
    docs: {
      description: { story: 'Modal is closed by default. Click **Open Modal** to show it.' },
    },
  },
};

// ─── Keyboard navigation ──────────────────────────────────────────────────────

/**
 * Focus trap + Escape demonstration.
 * Open the modal then press Tab / Shift+Tab and Escape.
 */
export const KeyboardNavigation: Story = {
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <>
        <Button onClick={() => setOpen(true)}>Open Modal</Button>
        <Modal open={open} onOpenChange={setOpen} title="Focus Trap Demo">
          <ModalHeader title="Focus Trap Demo" onClose={() => setOpen(false)} />
          <ModalContent>
            <p className="text-sm text-muted-foreground mb-4">
              Tab through the interactive elements below. Focus wraps when it reaches the
              last element. Press <kbd className="font-mono text-xs">Escape</kbd> to close.
            </p>
            <div className="space-y-3">
              <input
                className="w-full rounded border border-input px-3 py-2 text-sm"
                placeholder="First focusable input"
                aria-label="First focusable input"
              />
              <input
                className="w-full rounded border border-input px-3 py-2 text-sm"
                placeholder="Second focusable input"
                aria-label="Second focusable input"
              />
            </div>
          </ModalContent>
          <ModalFooter>
            <Button variant="outline" className="flex-1" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button className="flex-1">Submit</Button>
          </ModalFooter>
        </Modal>
      </>
    );
  },
  parameters: {
    docs: {
      description: {
        story:
          '`Tab` moves focus through inputs → Cancel → Submit → close icon → back to inputs. ' +
          '`Shift+Tab` reverses direction. `Escape` closes and returns focus to the trigger.',
      },
    },
  },
};

// ─── Long / scrollable content ────────────────────────────────────────────────

export const LongContent: Story = {
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <>
        <Button onClick={() => setOpen(true)}>Open Long Modal</Button>
        <Modal open={open} onOpenChange={setOpen} title="Terms and Conditions">
          <ModalHeader title="Terms and Conditions" onClose={() => setOpen(false)} />
          <ModalContent>
            <p className="text-sm text-muted-foreground mb-2">
              Please read all terms before confirming your rental agreement.
            </p>
            {Array.from({ length: 12 }).map((_, i) => (
              <p key={i} className="text-sm text-muted-foreground mb-2">
                Section {i + 1}: Lorem ipsum dolor sit amet, consectetur adipiscing elit.
                Praesent vehicula magna vel orci scelerisque, nec interdum erat
                condimentum. Nullam pharetra enim vitae odio congue facilisis.
              </p>
            ))}
          </ModalContent>
          <ModalFooter>
            <Button variant="outline" className="flex-1" onClick={() => setOpen(false)}>
              Decline
            </Button>
            <Button className="flex-1">I Agree</Button>
          </ModalFooter>
        </Modal>
      </>
    );
  },
  parameters: {
    docs: {
      description: {
        story:
          'When content overflows, the modal body scrolls independently. ' +
          'The footer stays pinned at the bottom.',
      },
    },
  },
};

// ─── Danger / destructive confirmation ────────────────────────────────────────

export const DestructiveAction: Story = {
  render: () => {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button variant="destructive" onClick={() => setOpen(true)}>
          Cancel Booking
        </Button>
        <Modal open={open} onOpenChange={setOpen} title="Cancel Booking">
          <ModalHeader title="Cancel Booking" onClose={() => setOpen(false)} />
          <ModalContent>
            <p className="text-sm text-muted-foreground">
              Are you sure you want to cancel this booking? This action cannot be undone
              and your refund eligibility will be calculated based on the cancellation policy.
            </p>
          </ModalContent>
          <ModalFooter>
            <Button variant="outline" className="flex-1" onClick={() => setOpen(false)}>
              Keep Booking
            </Button>
            <Button variant="destructive" className="flex-1" onClick={() => setOpen(false)}>
              Confirm Cancellation
            </Button>
          </ModalFooter>
        </Modal>
      </>
    );
  },
  parameters: {
    docs: {
      description: {
        story:
          'Destructive confirmation pattern: the primary action uses `variant="destructive"` ' +
          'and the safe path (**Keep Booking**) appears first so it receives initial focus.',
      },
    },
  },
};

// ─── No footer ────────────────────────────────────────────────────────────────

export const InformationOnly: Story = {
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <>
        <Button variant="secondary" onClick={() => setOpen(true)}>
          How Payments Work
        </Button>
        <Modal open={open} onOpenChange={setOpen} title="How Payments Work">
          <ModalHeader title="How Payments Work" onClose={() => setOpen(false)} />
          <ModalContent>
            <p className="text-sm text-muted-foreground">
              Rentars uses USDC escrow on the Stellar network. Funds are held in a
              smart contract and released automatically when your stay completes.
              No chargeback risk for hosts, instant settlement for guests.
            </p>
          </ModalContent>
        </Modal>
      </>
    );
  },
  parameters: {
    docs: {
      description: {
        story:
          'Information-only modals omit `ModalFooter`. The close icon in the header is the sole dismiss control.',
      },
    },
  },
};

// ─── Responsive (narrow viewport) ────────────────────────────────────────────

export const ResponsiveNarrow: Story = {
  parameters: {
    viewport: { defaultViewport: 'mobile1' },
    docs: {
      description: {
        story:
          'At narrow viewports the modal fills the available width with `max-w-md w-full` ' +
          'and `p-4` padding from its container.',
      },
    },
  },
  render: () => (
    <ControlledModal defaultOpen title="Mobile Modal">
      <ModalContent>
        <p className="text-sm text-muted-foreground">
          This modal adapts to narrow screens. The close icon remains reachable.
        </p>
      </ModalContent>
      <ModalFooter>
        <Button className="w-full">OK</Button>
      </ModalFooter>
    </ControlledModal>
  ),
};
