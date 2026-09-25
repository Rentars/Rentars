# Rentars Design System

This document is the single reference for all reusable UI primitives in the Rentars
frontend. Every component has an executable Storybook story linked in the table below.
Run `npx storybook dev` from `apps/web` to browse them interactively.

## Overview

The Rentars design system is built on:
- **shadcn/ui** — unstyled, accessible component primitives
- **Tailwind CSS** — utility-first styling with CSS variable tokens
- **Radix UI** — headless keyboard-accessible UI primitives
- **Lucide React** — consistent icon set
- **class-variance-authority (cva)** — type-safe variant management

---

## Component Inventory

| Component | Story path | Variants | States documented |
|---|---|---|---|
| `Button` | `UI/Button` | default, outline, ghost, secondary, destructive, link | normal, loading, disabled |
| `Badge` | `UI/Badge` | default, secondary, destructive, outline | all variants |
| `Input` | `UI/Input` | — | normal, disabled, error, with label |
| `Label` | `UI/Label` | — | normal, disabled (peer) |
| `Alert` | `UI/Alert` | default, destructive | default, destructive, success, warning, info, dismissible |
| `Card` | `UI/Card` | — | default, with-footer, property-style, minimal |
| `Modal` | `UI/Modal` | — | open, closed, keyboard, long-content, destructive, info-only, responsive |
| `LoadingSkeleton` | `UI/LoadingSkeleton` | Skeleton, PropertyCardSkeleton, PropertyListSkeleton, BookingSkeleton | all shapes |
| `ErrorDisplay` | `UI/ErrorDisplay` | ErrorDisplay, SuccessDisplay, InfoDisplay, WarningDisplay | with/without dismiss |
| `IconContainer` | `UI/IconContainer` | default, primary, secondary, destructive | sm / md / lg sizes |
| `BookingStatusBadge` | `Booking/BookingStatusBadge` | — | pending, confirmed, completed, cancelled, disputed |
| `BlockchainStatusBadge` | `Blockchain/BlockchainStatusBadge` | — | verified, pending, unverified |

---

## Color System

All colors are CSS custom properties defined in `src/app/globals.css` and consumed via
Tailwind's `hsl(var(--token))` syntax. Never hard-code hex or RGB values in components.

### Light Mode (Default)
```css
--background: 0 0% 100%;        /* page background */
--foreground: 0 0% 3.6%;        /* primary text */
--primary: 0 0% 9.0%;           /* primary actions */
--primary-foreground: 0 0% 98%; /* text on primary */
--secondary: 0 0% 96.1%;        /* secondary surfaces */
--secondary-foreground: 0 0% 9%;
--accent: 0 0% 9.0%;
--accent-foreground: 0 0% 98%;
--destructive: 0 84.2% 60.2%;   /* errors, deletions */
--destructive-foreground: 0 0% 98%;
--muted: 0 0% 96.1%;            /* subdued backgrounds */
--muted-foreground: 0 0% 45.1%;
--border: 0 0% 89.8%;
--ring: 0 0% 3.6%;
--card: 0 0% 100%;
--card-foreground: 0 0% 3.6%;
```

### Dark Mode
```css
--background: 0 0% 3.6%;
--foreground: 0 0% 98%;
--primary: 0 0% 98%;
--secondary: 0 0% 14.9%;
--accent: 0 0% 98%;
--destructive: 0 62.8% 30.6%;
--muted: 0 0% 14.9%;
--border: 0 0% 14.9%;
--card: 0 0% 3.6%;
```

---

## Component Reference

### Button

**Import:** `import { Button } from "@/components/ui"`

**Variants**

| Variant | Use case |
|---|---|
| `default` | Primary CTA — booking, confirmation, form submit |
| `outline` | Secondary action placed alongside a primary |
| `ghost` | Navigation items, icon-only toolbar buttons |
| `secondary` | Lower-priority actions on light backgrounds |
| `destructive` | Irreversible actions: cancel booking, delete listing |
| `link` | Inline text links |

**Sizes**

| Size | Height | Use case |
|---|---|---|
| `default` | 40 px | Standard controls |
| `sm` | 36 px | Compact toolbars, table rows |
| `lg` | 44 px | Hero CTAs |
| `icon` | 40 × 40 px | Icon-only buttons — **always supply `aria-label`** |

**States**

```tsx
// Loading — disable the button and inject a spinner inline
<Button disabled>
  <svg className="animate-spin h-4 w-4 mr-2" viewBox="0 0 24 24" aria-hidden="true">…</svg>
  Processing…
</Button>

// Disabled
<Button disabled>Unavailable</Button>

// As link (asChild renders the Button styles on an <a>)
<Button asChild>
  <a href="/properties">Browse Properties</a>
</Button>
```

**Keyboard behaviour**
- Focusable via `Tab` / `Shift+Tab`
- Activates on `Enter` and `Space`
- Disabled buttons receive `pointer-events-none opacity-50` — they are removed from the
  tab sequence by the native `disabled` attribute

**Responsive rules**
- Buttons do not shrink below their minimum tap target (44 × 44 px on mobile)
- Use `w-full` on mobile when the button is the sole action on a screen

---

### Badge

**Import:** `import { Badge } from "@/components/ui"`

**Variants**

| Variant | Token | When to use |
|---|---|---|
| `default` | primary | New listings, highlights |
| `secondary` | secondary | Availability, neutral info |
| `destructive` | destructive | Unavailable, errors |
| `outline` | border only | Booked, read-only state |

**Domain uses**

```tsx
<Badge variant="secondary">Available</Badge>
<Badge variant="outline">Booked</Badge>
<Badge variant="default">New</Badge>
<Badge variant="destructive">Unavailable</Badge>
```

**Accessibility**
- `Badge` renders a `<div>` — if the badge communicates a live state change, wrap it in
  an element with `role="status"` or use `BookingStatusBadge` which already does this.

---

### Input

**Import:** `import { Input } from "@/components/ui"`

**Types supported:** `text`, `email`, `password`, `number`, `date`, `search`, `tel`, `url`

**States**

```tsx
// Normal
<Input placeholder="Search properties…" />

// Disabled
<Input disabled defaultValue="Read-only value" />

// Error — pair with aria-invalid and an error message linked via aria-describedby
<Input
  id="email"
  type="email"
  aria-invalid={true}
  aria-describedby="email-error"
  className="border-destructive focus-visible:ring-destructive"
/>
<p id="email-error" className="text-sm text-destructive">
  Please enter a valid email address.
</p>
```

**Usage constraints**
- Always pair an `<Input>` with a `<Label>` — either visible or screen-reader-only via
  `sr-only`. Do not rely on `placeholder` as the only label.
- In forms, use `react-hook-form` with Zod validation to drive `aria-invalid` and error
  messages automatically.

---

### Label

**Import:** `import { Label } from "@/components/ui"`

```tsx
<Label htmlFor="field-id">Field name</Label>
<Input id="field-id" />
```

**Disabled peer styling**
When the sibling input is disabled, the label automatically fades via
`peer-disabled:opacity-70`. This requires the input to appear before the label in the DOM
and both to share a common parent — or use the `peer` / `peer-disabled` pattern explicitly.

---

### Alert

**Import:** `import { Alert, AlertTitle, AlertDescription } from "@/components/ui"`

**Variants**

| Variant | Use case |
|---|---|
| `default` | Neutral informational messages |
| `destructive` | Errors, payment failures, validation summaries |

**Domain extensions** (no extra variant — compose with Tailwind)

```tsx
// Success
<Alert className="border-green-200 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950 dark:text-green-100">
  <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
  <AlertTitle>Booking confirmed</AlertTitle>
  <AlertDescription>Your reservation has been placed.</AlertDescription>
</Alert>

// Warning
<Alert className="border-yellow-200 bg-yellow-50 text-yellow-900 …">
  <TriangleAlert className="h-4 w-4 text-yellow-600 …" />
  <AlertTitle>Dates unavailable</AlertTitle>
  <AlertDescription>Some dates in your selection are blocked.</AlertDescription>
</Alert>
```

For a managed dismiss button with typed variants, use `ErrorDisplay` / `SuccessDisplay` /
`InfoDisplay` / `WarningDisplay` from `@/components/ui/error-display`.

**Accessibility**
- Alert renders with `role="alert"` — screen readers announce new instances automatically.
- For live regions that update without full re-mounts, set `aria-live="polite"` on a
  container and toggle alert content inside it.

---

### Card

**Import:** `import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui"`

**Anatomy**

```tsx
<Card>
  <CardHeader>
    <CardTitle>Title</CardTitle>         {/* <h2> */}
    <CardDescription>Subtitle</CardDescription>
  </CardHeader>
  <CardContent>…</CardContent>
  <CardFooter>…</CardFooter>             {/* optional */}
</Card>
```

**Responsive rules**
- Cards use `w-full` by default — constrain width on the parent grid, not the card.
- Property cards use `overflow-hidden` to clip the hero image at the rounded corners.

---

### Modal

**Import:** `import { Modal, ModalHeader, ModalContent, ModalFooter } from "@/components/ui/modal"`

**Anatomy**

```tsx
const [open, setOpen] = useState(false);

<Modal open={open} onOpenChange={setOpen} title="Dialog title">
  <ModalHeader title="Dialog title" onClose={() => setOpen(false)} />
  <ModalContent>…body…</ModalContent>
  <ModalFooter>
    <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
    <Button onClick={() => setOpen(false)}>Confirm</Button>
  </ModalFooter>
</Modal>
```

**Keyboard behaviour**

| Key | Action |
|---|---|
| `Tab` | Move focus to the next interactive element inside the modal |
| `Shift + Tab` | Move focus to the previous element — wraps from first to last |
| `Escape` | Close the modal and return focus to the element that opened it |

**ARIA attributes**
- `role="dialog"` — identifies the container to AT
- `aria-modal="true"` — suppresses background content in virtual browsing modes
- `aria-labelledby="modal-title"` — linked to the `<h2>` in `ModalHeader`
- Close button has `aria-label="Close modal"`

**Usage constraints**
- `title` is required — it becomes the accessible name.
- `ModalFooter` is optional. For information-only dialogs, omit it and use the close icon.
- The destructive confirmation pattern: place the safe action first so it receives initial
  focus when the modal opens.
- Do not nest modals.

**Responsive rules**
- The dialog panel uses `max-w-md w-full` — it fills the viewport on narrow screens.
- `max-h-[90vh] overflow-y-auto` on the inner panel allows long content to scroll without
  the footer scrolling off-screen.

---

### LoadingSkeleton

**Import:** `import { Skeleton, PropertyCardSkeleton, PropertyListSkeleton, BookingSkeleton } from "@/components/ui"`

**Shapes**

```tsx
// Generic — size via className
<Skeleton className="h-4 w-48" />
<Skeleton className="h-12 w-12 rounded-full" />

// Domain skeletons
<PropertyCardSkeleton />             // single card
<PropertyListSkeleton count={6} />   // responsive grid
<BookingSkeleton />                  // booking summary panel
```

**Usage constraints**
- Add `aria-busy="true"` and `aria-label="Loading…"` to the outermost container while
  skeletons are visible so screen readers announce the loading state.
- Skeletons must mirror the final layout — size, spacing, and grid structure should match
  the real component to eliminate cumulative layout shift (CLS).

---

### ErrorDisplay / SuccessDisplay / InfoDisplay / WarningDisplay

**Import:** `import { ErrorDisplay, SuccessDisplay, InfoDisplay, WarningDisplay } from "@/components/ui"`

**Common props**

| Prop | Type | Default | Description |
|---|---|---|---|
| `title` | `string` | variant-dependent | Heading text |
| `message` | `string` | — | Body text |
| `onDismiss` | `() => void` | optional | Shows a Dismiss button when provided |
| `className` | `string` | optional | Override wrapper styles |

```tsx
<ErrorDisplay
  title="Payment failed"
  message="Insufficient USDC balance."
  onDismiss={() => clearError()}
/>

<SuccessDisplay
  title="Booking confirmed"
  message="Check your email for details."
/>
```

---

### IconContainer

**Import:** `import { IconContainer } from "@/components/ui"`

**Sizes**

| Size | Dimensions |
|---|---|
| `sm` | 32 × 32 px |
| `md` | 40 × 40 px (default) |
| `lg` | 48 × 48 px |

**Variants:** `default` (muted bg), `primary`, `secondary`, `destructive`

```tsx
import { Home } from 'lucide-react';

<IconContainer size="md" variant="primary" aria-hidden="true">
  <Home />
</IconContainer>
```

**Accessibility**
- `IconContainer` is a presentational wrapper — always add `aria-hidden="true"` when the
  icon is decorative, or provide `aria-label` on the container when it conveys meaning
  without adjacent text.

---

### BookingStatusBadge

**Import:** `import BookingStatusBadge from "@/components/booking/BookingStatusBadge"`

**States**

| Status | Colour | When |
|---|---|---|
| `pending` | Amber | Booking created, awaiting host |
| `confirmed` | Blue | Host accepted, escrow funded |
| `completed` | Green | Stay finished, funds released |
| `cancelled` | Gray | Cancelled before check-in |
| `disputed` | Red | Active dispute |

**Normalisation**
Accepts both lowercase (`"pending"`) and title-case (`"Pending"`) strings — the component
normalises the value internally so callers never need to pre-process API responses.

**Accessibility**
- Renders `role="status"` so AT announces changes.
- `aria-label` is set to `"Booking status: <state>"`.

---

### BlockchainStatusBadge

**Import:** `import BlockchainStatusBadge from "@/components/blockchain/BlockchainStatusBadge"`

**States**

| `status` flag | Label | Colour |
|---|---|---|
| `verified: true` | Verified | Green |
| `pending: true` | Pending | Yellow |
| `failed: true` | Failed | Red |
| all false | Unverified | Gray |
| null / non-object | Unknown | Gray |

---

## Form Patterns

### Validated form with react-hook-form + Zod

```tsx
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button, Input, Label, ErrorDisplay } from '@/components/ui';

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export function LoginForm() {
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm({
    resolver: zodResolver(schema),
  });

  return (
    <form onSubmit={handleSubmit(…)} className="space-y-4">
      <div className="space-y-1">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          aria-invalid={!!errors.email}
          aria-describedby={errors.email ? 'email-error' : undefined}
          {...register('email')}
        />
        {errors.email && (
          <p id="email-error" className="text-sm text-destructive">
            {errors.email.message}
          </p>
        )}
      </div>

      <div className="space-y-1">
        <Label htmlFor="password">Password</Label>
        <Input id="password" type="password" {...register('password')} />
      </div>

      <Button type="submit" className="w-full" disabled={isSubmitting}>
        {isSubmitting ? 'Signing in…' : 'Sign In'}
      </Button>
    </form>
  );
}
```

---

## Tailwind CSS Configuration

Key design tokens from `tailwind.config.js`:

```js
// Breakpoints
screens: { sm: '640px', md: '768px', lg: '1024px', xl: '1280px', '2xl': '1536px' }

// Dark mode strategy
darkMode: ['class']   // toggle .dark on <html>
```

---

## Accessibility Checklist

Before shipping a new component or page, verify:

- [ ] Every interactive element is reachable by `Tab`
- [ ] Focus is visible (ring classes from `ring-ring`)
- [ ] `aria-label` or adjacent visible text for icon-only controls
- [ ] Color is not the only means of conveying information
- [ ] `disabled` state is indicated both visually and via the `disabled` attribute
- [ ] Form errors link error messages via `aria-describedby`
- [ ] Modals trap focus and restore it on close
- [ ] Loading states use `aria-busy` and `aria-label`
- [ ] Status changes use `role="status"` or `role="alert"` as appropriate

---

## Dark Mode

Enable dark mode by adding the `.dark` class to `<html>`:

```tsx
// app/layout.tsx
<html className={theme}>…</html>
```

Use `next-themes` for dynamic switching — see `src/context/ThemeProvider.tsx`.

All design tokens automatically invert. Never use hard-coded colors in components — always
use CSS variable tokens (`bg-background`, `text-foreground`, etc.).

---

## Adding New Components

1. Create the component in `src/components/ui/<name>.tsx`
2. Export it from `src/components/ui/index.ts`
3. Add a story in `src/stories/ui/<Name>.stories.tsx` that covers:
   - All variants and sizes
   - Normal, loading, error, and disabled states
   - Keyboard navigation (for interactive components)
   - Dark mode (the Storybook toolbar theme toggle handles this)
4. Write unit tests in `src/components/ui/tests/<Name>.test.tsx` that assert:
   - ARIA attributes
   - Keyboard events (Escape, Enter, Tab)
   - Disabled / loading state behavior
5. Document the component in this file

---

## Resources

- [shadcn/ui Documentation](https://ui.shadcn.com)
- [Tailwind CSS Documentation](https://tailwindcss.com)
- [Radix UI Documentation](https://www.radix-ui.com)
- [Lucide Icons](https://lucide.dev)
- [WAI-ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/)
- [WCAG 2.1 Quick Reference](https://www.w3.org/WAI/WCAG21/quickref/)
