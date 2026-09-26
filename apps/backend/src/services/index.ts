/**
 * Shared service types used across all service modules.
 */

/**
 * Standard response envelope returned by every service function.
 *
 * @template T - The shape of the `data` payload on success.
 */
export interface ServiceResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  warning?: string;
  statusCode?: number;
  /** True when failure is due to a booking date conflict (maps to HTTP 409). */
  conflict?: boolean;
}

export type { PaginatedResult } from '../types/pagination.js';
