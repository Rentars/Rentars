import { describe, expect, it } from 'bun:test';
import { executePaginatedQuery } from '../utils/pagination.js';

describe('executePaginatedQuery', () => {
  it('returns zero total pages for zero results', async () => {
    const result = await executePaginatedQuery({
      range: async () => ({ data: [], error: null, count: 0 }),
    }, 1, 20);

    expect(result).toEqual({
      result: { data: [], pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 } },
    });
  });

  it('does not add an extra page for an exact multiple', async () => {
    const result = await executePaginatedQuery({
      range: async (from, to) => {
        expect(from).toBe(20);
        expect(to).toBe(39);
        return { data: Array.from({ length: 20 }, (_, index) => index), error: null, count: 40 };
      },
    }, 2, 20);

    expect(result.result?.pagination.totalPages).toBe(2);
  });
});