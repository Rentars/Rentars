/**
 * Stories for BookingStatusBadge.
 *
 * Covers every lifecycle state a booking can reach:
 *   pending → confirmed → completed | cancelled | disputed
 *
 * Also verifies the badge normalises both title-case API values (e.g. "Pending")
 * and lowercase values so callers never need to pre-process the status string.
 */
import type { Meta, StoryObj } from '@storybook/react';
import BookingStatusBadge from '@/components/booking/BookingStatusBadge';

const meta: Meta<typeof BookingStatusBadge> = {
  title: 'Booking/BookingStatusBadge',
  component: BookingStatusBadge,
  tags: ['autodocs'],
  argTypes: {
    status: {
      control: 'select',
      options: ['pending', 'confirmed', 'completed', 'cancelled', 'disputed'],
      description: 'Current booking lifecycle state',
    },
    className: {
      control: 'text',
      description: 'Additional Tailwind classes for size or spacing overrides',
    },
  },
  args: {
    status: 'pending',
  },
  parameters: {
    docs: {
      description: {
        component: `
A pill badge that reflects the current booking lifecycle state.

**States**
| Status | Colour | When used |
|---|---|---|
| \`pending\` | Amber | Booking created, awaiting host confirmation |
| \`confirmed\` | Blue | Host accepted — escrow funded |
| \`completed\` | Green | Stay finished — funds released |
| \`cancelled\` | Gray | Either party cancelled before check-in |
| \`disputed\` | Red | Guest or host opened a dispute |

**Accessibility**
- Uses \`role="status"\` so screen readers announce status changes.
- Provides an explicit \`aria-label\` of the form _"Booking status: Confirmed"_.

**Usage constraints**
- Accepts both lowercase (\`"pending"\`) and title-case (\`"Pending"\`) strings to match raw API responses.
- Unknown values are rendered verbatim with a neutral gray style.
        `,
      },
    },
  },
};
export default meta;

type Story = StoryObj<typeof BookingStatusBadge>;

// ─── Individual lifecycle states ──────────────────────────────────────────────

export const Pending: Story = {
  args: { status: 'pending' },
};

export const Confirmed: Story = {
  args: { status: 'confirmed' },
};

export const Completed: Story = {
  args: { status: 'completed' },
};

export const Cancelled: Story = {
  args: { status: 'cancelled' },
};

export const Disputed: Story = {
  args: { status: 'disputed' },
};

// ─── Title-case (raw API) normalisation ───────────────────────────────────────

export const TitleCaseNormalisation: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2 p-4">
      {(['Pending', 'Confirmed', 'Completed', 'Cancelled', 'Disputed'] as const).map(
        (s) => <BookingStatusBadge key={s} status={s} />,
      )}
    </div>
  ),
  parameters: {
    docs: {
      description: {
        story:
          'Title-case values as returned directly from the API are normalised to lowercase ' +
          'before the colour lookup — no pre-processing required by callers.',
      },
    },
  },
};

// ─── All states at once (visual reference) ────────────────────────────────────

export const AllStates: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2 p-4">
      {(['pending', 'confirmed', 'completed', 'cancelled', 'disputed'] as const).map(
        (s) => <BookingStatusBadge key={s} status={s} />,
      )}
    </div>
  ),
};

// ─── Dark mode ────────────────────────────────────────────────────────────────

export const DarkMode: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2 p-4 bg-gray-900 rounded-lg">
      {(['pending', 'confirmed', 'completed', 'cancelled', 'disputed'] as const).map(
        (s) => <BookingStatusBadge key={s} status={s} />,
      )}
    </div>
  ),
  parameters: {
    docs: {
      description: {
        story: 'All states in dark-mode context — each badge uses dark-variant Tailwind classes.',
      },
    },
  },
};

// ─── Size overrides via className ────────────────────────────────────────────

export const LargeSize: Story = {
  args: { status: 'confirmed', className: 'text-sm px-3 py-1' },
  parameters: {
    docs: {
      description: {
        story:
          'Pass `className` to override size — the booking confirmation page uses `text-sm px-3 py-1`.',
      },
    },
  },
};

// ─── Unknown / fallback status ────────────────────────────────────────────────

export const UnknownStatus: Story = {
  args: { status: 'processing' as string },
  parameters: {
    docs: {
      description: {
        story:
          'Unknown status values are rendered verbatim with a neutral gray style as a safe fallback.',
      },
    },
  },
};
