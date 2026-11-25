/**
 * Clock abstraction for deterministic time-dependent testing.
 *
 * Production code uses `Clock.now()` and `Clock.date()` instead of direct
 * `Date.now()` or `new Date()` calls, allowing tests to inject a fixed time.
 *
 * Usage in production:
 *   const timestamp = Clock.now();
 *   const expiry = Clock.date(timestamp + 3600000);
 *
 * Usage in tests:
 *   beforeEach(() => {
 *     Clock.setFixed(new Date('2027-01-15T10:00:00Z'));
 *   });
 *   afterEach(() => {
 *     Clock.reset();
 *   });
 */

export type ClockProvider = () => Date;

class ClockService {
  private fixedTime: Date | null = null;

  /**
   * Returns the current time as a Date object.
   * Uses fixed time if set, otherwise returns actual current time.
   */
  date(): Date {
    return this.fixedTime ? new Date(this.fixedTime) : new Date();
  }

  /**
   * Returns the current time as milliseconds since Unix epoch.
   * Uses fixed time if set, otherwise returns actual current time.
   */
  now(): number {
    return this.fixedTime ? this.fixedTime.getTime() : Date.now();
  }

  /**
   * Sets a fixed time for all Clock operations.
   * Used in tests to make time-dependent behavior deterministic.
   *
   * @param time - Fixed date/time to use
   */
  setFixed(time: Date): void {
    this.fixedTime = new Date(time);
  }

  /**
   * Advances the fixed clock by the specified milliseconds.
   * Throws if no fixed time has been set.
   *
   * @param ms - Milliseconds to advance
   */
  advance(ms: number): void {
    if (!this.fixedTime) {
      throw new Error('Cannot advance clock: no fixed time set');
    }
    this.fixedTime = new Date(this.fixedTime.getTime() + ms);
  }

  /**
   * Resets to real time (removes fixed time).
   * Always call in test cleanup to avoid leaking state.
   */
  reset(): void {
    this.fixedTime = null;
  }

  /**
   * Returns true if a fixed time is currently set.
   */
  isFixed(): boolean {
    return this.fixedTime !== null;
  }

  /**
   * Returns the current fixed time, or null if using real time.
   */
  getFixed(): Date | null {
    return this.fixedTime ? new Date(this.fixedTime) : null;
  }
}

/**
 * Singleton clock instance.
 * Import and use this in production code and tests.
 */
export const Clock = new ClockService();

/**
 * Type guard for environment validation.
 * Ensures Clock is reset between tests in non-production environments.
 */
export function ensureClockReset(): void {
  if (process.env.NODE_ENV !== 'production' && Clock.isFixed()) {
    console.warn('Warning: Clock was not reset after previous test');
    Clock.reset();
  }
}
