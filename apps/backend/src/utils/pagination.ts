import type { PaginatedResult } from '../types/pagination.js';

interface PaginatedQuery<T> {
  range(from: number, to: number): PromiseLike<{
    data: T[] | null;
    error: { message: string } | null;
    count: number | null;
  }>;
}

export async function executePaginatedQuery<T>(
  query: PaginatedQuery<T>,
  page: number,
  pageSize: number,
): Promise<{ result?: PaginatedResult<T>; error?: string }> {
  const from = (page - 1) * pageSize;
  const response = await query.range(from, from + pageSize - 1);

  if (response.error) return { error: response.error.message };

  const total = response.count ?? 0;
  return {
    result: {
      data: response.data ?? [],
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    },
  };
}