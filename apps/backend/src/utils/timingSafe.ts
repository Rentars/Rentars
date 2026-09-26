/**
 * Timing-safe utilities for authentication operations.
 * Prevents account enumeration attacks based on response time differences.
 */

/**
 * Add delay to equalize response timing across success/failure paths.
 * Uses jitter to prevent timing analysis.
 *
 * @param minDelayMs - Minimum delay in milliseconds
 */
export async function constantTimeDelay(minDelayMs: number = 50): Promise<void> {
  const randomJitter = Math.random() * minDelayMs;
  const totalDelay = minDelayMs + randomJitter;

  return new Promise(resolve => setTimeout(resolve, totalDelay));
}

/**
 * Wrapper for operations that should have consistent timing.
 * Adds padding delay if operation completes too quickly.
 *
 * @param operation - Async function to execute
 * @param minDelayMs - Minimum total execution time including padding
 */
export async function withConstantTiming<T>(
  operation: () => Promise<T>,
  minDelayMs: number = 50,
): Promise<T> {
  const startTime = Date.now();
  const result = await operation();
  const elapsedMs = Date.now() - startTime;

  if (elapsedMs < minDelayMs) {
    const remainingDelay = minDelayMs - elapsedMs + Math.random() * minDelayMs;
    await new Promise(resolve => setTimeout(resolve, remainingDelay));
  }

  return result;
}
