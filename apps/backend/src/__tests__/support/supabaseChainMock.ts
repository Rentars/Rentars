/**
 * Shared Supabase test double for listing lifecycle tests.
 *
 * Each table's rows are seeded per test through `tables`. Filters are ignored,
 * so a test seeds exactly the rows it wants the service to see. `single` and
 * `maybeSingle` return the first row, and awaiting a chain returns every row
 * with a count.
 *
 * Isolation contract:
 *  - Call `resetTables()` in `beforeEach` — never rely on state from a previous test.
 *  - Use `makeTestId(label)` for all fixture IDs to avoid collisions when tests
 *    run in parallel with `--workers`.
 *  - Seed only the rows a specific test needs; do not share mutable row objects
 *    across tests.
 */

import { vi } from 'vitest';

export const tables: Record<string, Array<Record<string, unknown>>> = {};

export function resetTables(): void {
  for (const key of Object.keys(tables)) delete tables[key];
}

/**
 * Returns a unique ID for use in fixture data.
 * Embedding Date.now() + random ensures parallel workers don't collide.
 *
 *   const propId = makeTestId('prop');   // 'prop-1748234521-a3f9'
 */
export function makeTestId(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function rowsFor(table: string): Array<Record<string, unknown>> {
  return tables[table] ?? [];
}

function chainFor(table: string): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  const passthrough = () => chain;
  for (const method of [
    'select', 'insert', 'update', 'delete', 'eq', 'neq', 'lt', 'lte', 'gt', 'gte',
    'is', 'in', 'not', 'or', 'order', 'limit', 'ilike', 'contains',
  ]) {
    chain[method] = vi.fn(passthrough);
  }
  chain.single = vi.fn(async () => ({ data: rowsFor(table)[0] ?? null, error: null }));
  chain.maybeSingle = vi.fn(async () => ({ data: rowsFor(table)[0] ?? null, error: null }));
  chain.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve({ data: rowsFor(table), error: null, count: rowsFor(table).length }).then(resolve, reject);
  return chain;
}

export const supabaseMock = {
  from: (table: string) => chainFor(table),
  rpc: vi.fn(),
};
