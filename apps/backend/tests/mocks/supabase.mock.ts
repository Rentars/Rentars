/**
 * Supabase mock — chainable mock that simulates .from().select().eq() etc.
 * Compatible with bun:test mock API.
 *
 * Isolation contract:
 *  - Call `createMockSupabase()` inside `beforeEach` (not at module scope) so
 *    each test gets a fresh mock with no prior call history.
 *  - Alternatively, call `.mockReset()` on `mockFrom` and `mockRpc` in
 *    `beforeEach` before configuring new implementations.
 *  - Never share a mock instance between describe blocks.
 */

import { mock } from 'bun:test';

export interface MockSupabaseQuery {
  select: ReturnType<typeof mock>;
  eq: ReturnType<typeof mock>;
  neq: ReturnType<typeof mock>;
  single: ReturnType<typeof mock>;
  insert: ReturnType<typeof mock>;
  update: ReturnType<typeof mock>;
  delete: ReturnType<typeof mock>;
  upsert: ReturnType<typeof mock>;
  order: ReturnType<typeof mock>;
  limit: ReturnType<typeof mock>;
  ilike: ReturnType<typeof mock>;
  gte: ReturnType<typeof mock>;
  lte: ReturnType<typeof mock>;
  lt: ReturnType<typeof mock>;
  gt: ReturnType<typeof mock>;
}

export function createMockSupabaseQuery(): MockSupabaseQuery {
  const query: any = {
    select: mock(() => query),
    eq: mock(() => query),
    neq: mock(() => query),
    single: mock(() => Promise.resolve({ data: null, error: null })),
    insert: mock(() => query),
    update: mock(() => query),
    delete: mock(() => query),
    upsert: mock(() => query),
    order: mock(() => query),
    limit: mock(() => query),
    ilike: mock(() => query),
    gte: mock(() => query),
    lte: mock(() => query),
    lt: mock(() => query),
    gt: mock(() => query),
  };
  return query;
}

export function createMockSupabase() {
  return {
    from: mock((_table: string) => createMockSupabaseQuery()),
    auth: {
      signUp: mock(() => Promise.resolve({ data: null, error: null })),
      signInWithPassword: mock(() => Promise.resolve({ data: null, error: null })),
      admin: {
        createUser: mock(() => Promise.resolve({ data: null, error: null })),
        deleteUser: mock(() => Promise.resolve({ data: null, error: null })),
      },
    },
  };
}
