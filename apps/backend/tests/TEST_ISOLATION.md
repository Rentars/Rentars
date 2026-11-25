# Backend Test Isolation Guide

This document defines the rules that make the backend test suite safe to run
in any order and with parallel Bun workers.

---

## The problem these rules solve

A test suite has order-dependent failures when:

- A module-level fixture object is mutated by one test and read in a different state by another.
- A mock is configured in one test (`mockFrom.mockImplementation(...)`) and not reset before the next.
- Multiple tests share the same database row IDs, so a parallel worker's cleanup deletes rows another worker is reading.

Bun exposes these problems via `bun test --reorder` (randomises order within a file) and `bun test --workers N` (runs files concurrently). Tests that depend on shared state fail under these modes.

---

## Rules

### 1. No mutable module-level fixtures

**Don't** do this:

```typescript
// BAD — shared mutable state
const sharedBooking = { id: 'booking-fixed', status: 'Pending' };

it('confirms the booking', async () => {
  sharedBooking.status = 'Confirmed'; // mutates shared state
  // ...
});

it('cancels the booking', async () => {
  // expects sharedBooking.status to be 'Pending' — fails if 'confirms' ran first
});
```

**Do** this instead:

```typescript
import { bookingFactory } from '../fixtures/test-factory.js';

it('confirms the booking', async () => {
  const booking = bookingFactory({ status: 'Pending' }); // fresh each time
  // ...
});

it('cancels the booking', async () => {
  const booking = bookingFactory({ status: 'Pending' }); // own copy
  // ...
});
```

### 2. Reset mocks in `beforeEach`

Call `.mockClear()` or `.mockReset()` on every mock in `beforeEach`.
`.mockClear()` resets call counts but preserves the implementation.
`.mockReset()` also removes any `mockImplementation` set by a previous test.

```typescript
// bun:test
beforeEach(() => {
  mockFrom.mockReset();
  mockRpc.mockReset();
  mockCreateEscrow.mockReset();
  mockCancelEscrow.mockReset();
});
```

For tests in `src/__tests__/` that use `supabaseChainMock`:

```typescript
import { resetTables } from './support/supabaseChainMock.js';

beforeEach(() => {
  resetTables();
});
```

### 3. Unique IDs via `makeRunId()`

Every test that creates mock rows must prefix all IDs with a run-scoped token.

```typescript
import { makeRunId, userFactory, bookingFactory } from '../fixtures/test-factory.js';

const RUN = makeRunId(); // created once per describe block

it('creates a booking', async () => {
  const user = userFactory({ id: `${RUN}-user` });
  const booking = bookingFactory({ id: `${RUN}-booking`, tenant_id: user.id });
  // ...
});
```

`makeRunId()` returns a string like `run-1748234521-a3f9`, unique per process
invocation, so parallel workers never generate the same IDs.

### 4. Seed only what the test needs

When configuring `mockFrom`, return rows only for the tables and query shapes the
test exercises. Don't seed a 10-row array in `beforeEach` and expect each test to
know which rows it owns.

```typescript
it('returns a 404 for a missing booking', async () => {
  mockFrom.mockImplementation(() => ({
    select: mock(() => ({
      eq: mock(() => ({
        single: mock(async () => ({ data: null, error: { message: 'Not found' } })),
      })),
    })),
  }));
  // ...
});
```

### 5. Integration tests that touch a real DB

Tests in `tests/rls/` and any future integration tests that write to Supabase
directly must use `makeCleanupTracker()` from `tests/fixtures/test-factory.ts`.

```typescript
import { makeCleanupTracker, bookingFactory } from '../fixtures/test-factory.js';

const tracker = makeCleanupTracker();

afterEach(async () => {
  await tracker.cleanup(supabase);
});

it('creates a booking', async () => {
  const id = tracker.track('bookings', crypto.randomUUID());
  const booking = bookingFactory({ id });
  await supabase.from('bookings').insert(booking);
  // ...
});
```

`cleanup()` deletes rows in reverse-dependency order
(notifications → reviews → bookings → properties → profiles), so foreign-key
constraints are never violated.

### 6. `booking-journey.test.ts` isolation pattern

The journey test uses a `RUN_ID` prefix on all seeded IDs. Its Phase 10
assertion verifies no data was written outside the namespace. This is the
reference implementation for large integration tests that need many related rows.

---

## Verifying isolation

Run these commands locally before merging a new test file:

```bash
cd apps/backend

# Randomised order within files — exposes order-dependent failures
bun test tests/unit --reorder

# Parallel workers — exposes shared mock state between files
bun test tests/unit --workers 4

# Combined
bun test tests/unit --reorder --workers 4
```

If any run produces different pass/fail results from a sequential run,
the new test has an isolation problem.

---

## `src/__tests__/` vs `tests/`

The backend has two test directories with different mock APIs:

| Directory | Runner | Mock API | Supabase mock |
|---|---|---|---|
| `src/__tests__/` | `bun test` (runs via vitest compatible imports) | `vi.fn()` from `vitest` | `supabaseChainMock.ts` (table-keyed row store) |
| `tests/` | `bun test` | `mock()` from `bun:test` | `tests/mocks/supabase.mock.ts` (chainable builder) |

New tests in `src/__tests__/` must use `vi.fn()` and `resetTables()`.
New tests in `tests/` must use `mock()` from `bun:test` and `mockReset()`.

Do not mix the two mock APIs in the same test file.
