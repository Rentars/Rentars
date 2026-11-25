# Test Fixtures

This directory contains per-test factory functions and isolation helpers for the
backend test suite.

---

## Why factories instead of shared fixtures

Shared module-level fixture objects (e.g. `const user = { id: 'fixed-uuid', ... }`)
cause order-dependent test failures because:

- Tests that mutate or delete the shared object affect every test that runs after them.
- Running with `bun test --reorder` or multiple `--workers` exposes hidden coupling.
- A failing assertion in one test may leave shared state in an inconsistent shape for
  the next.

Factories produce a fresh object per call, so each test owns its data.

---

## `test-factory.ts`

| Export | Purpose |
|---|---|
| `makeRunId()` | Returns a short unique string to prefix all IDs in a test run |
| `userFactory(overrides?)` | Builds a `TestUser` object |
| `hostFactory(overrides?)` | Builds a host-role `TestUser` |
| `propertyFactory(overrides?)` | Builds a `TestProperty` object |
| `bookingFactory(overrides?)` | Builds a `TestBooking` in `Pending` status |
| `confirmedBookingFactory(overrides?)` | Builds a `TestBooking` in `Confirmed` status with an escrow ID |
| `reviewFactory(overrides?)` | Builds a `TestReview` |
| `notificationFactory(overrides?)` | Builds a `TestNotification` |
| `makeCleanupTracker()` | Tracks inserted IDs and deletes them in dependency order |

---

## Rules

### 1. Reset mocks in `beforeEach`

Always call `mockClear()` (bun:test) or `vi.clearAllMocks()` (vitest) in `beforeEach`
before seeding new data. Never rely on mock state left by a previous test.

```typescript
// bun:test
beforeEach(() => {
  mockFrom.mockClear();
  mockRpc.mockClear();
  mockCreateEscrow.mockClear();
});
```

### 2. Seed only what the test needs

Only put the rows a specific test requires into the mock. If you seed more rows than
necessary, a future test might read them and pass for the wrong reason.

```typescript
// Good — seed the minimum
it('returns a booking', async () => {
  const booking = bookingFactory({ id: `${RUN}-b1` });
  mockFrom.mockImplementation((table) => {
    if (table === 'bookings') return singleRow(booking);
    return emptyQuery();
  });
  // ...
});
```

### 3. Use `makeRunId()` for all IDs

Create `const RUN = makeRunId()` once per `describe` block (or test file) and prefix
every ID with it. This ensures parallel CI runs don't collide.

```typescript
const RUN = makeRunId();

it('creates a booking', async () => {
  const user = userFactory({ id: `${RUN}-user` });
  const prop = propertyFactory({ id: `${RUN}-prop`, owner_id: user.id });
  const booking = bookingFactory({ id: `${RUN}-booking`, property_id: prop.id, tenant_id: user.id });
  // ...
});
```

### 4. No cross-test dependencies

Each `it` block must be able to run in isolation. Never set a variable in one test
and read it in another. If two tests need the same data, each creates it independently.

### 5. Integration tests that touch a real DB

Use `makeCleanupTracker()` and register every inserted ID. Call `tracker.cleanup(supabase)`
in `afterEach`. This ensures the test deletes only the rows it inserted — never rows
created by other tests or seed data.

---

## Parallel-safety checklist

Before merging a new test file, verify:

- [ ] All mock objects are created inside `beforeEach` or inside the `it` body.
- [ ] No `const fixture = { ... }` defined at module scope that tests mutate.
- [ ] All DB row IDs include the `RUN` prefix.
- [ ] Running `bun test tests/unit --reorder` ten times produces the same pass/fail results.
- [ ] Running `bun test tests/unit --workers 4` produces the same pass/fail results.
