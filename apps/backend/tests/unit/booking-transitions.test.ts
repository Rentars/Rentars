import { VALID_TRANSITIONS, TERMINAL_STATES } from '../../src/services/booking.service';

// ---------------------------------------------------------------------------
// Canonical booking lifecycle transition graph (issue #761)
//
// `BookingService.transitionStatus` is the single place that mutates
// `bookings.status`: it looks up VALID_TRANSITIONS[fromStatus], rejects any
// toStatus not in that list with a stable 409 conflict, and only then writes
// the status change plus a durable `booking_status_history` row (actor,
// reason, from_status). These tests pin the graph itself, independent of the
// Supabase-backed method, so a future edit that quietly opens up an invalid
// edge (e.g. Completed -> Pending) gets caught here.
//
// Note: PR #892 adds a separate, narrower `transitionBookingState` helper
// scoped to escrow-reconciliation states (confirmed / escrow_reconcile_failed
// / escrow_manual_review) inside sync.service.ts. It is not a duplicate of
// this graph — it does not touch Pending/Confirmed/Disputed/Completed/
// Cancelled/Expired — and is left as-is.
// ---------------------------------------------------------------------------

describe('VALID_TRANSITIONS (booking lifecycle graph)', () => {
  it('every terminal state has no outgoing transitions', () => {
    for (const state of TERMINAL_STATES) {
      expect(VALID_TRANSITIONS[state]).toEqual([]);
    }
  });

  it('every state referenced as a destination is a known state', () => {
    const knownStates = new Set(Object.keys(VALID_TRANSITIONS));
    for (const [from, destinations] of Object.entries(VALID_TRANSITIONS)) {
      for (const to of destinations) {
        expect(knownStates.has(to)).toBe(true);
        void from;
      }
    }
  });

  it('a state is never listed as its own valid destination (no-op self-loop)', () => {
    for (const [from, destinations] of Object.entries(VALID_TRANSITIONS)) {
      expect(destinations.includes(from)).toBe(false);
    }
  });

  it('rejects Pending -> Completed (must pass through Confirmed first)', () => {
    expect(VALID_TRANSITIONS.Pending).not.toContain('Completed');
  });

  it('rejects Cancelled -> anything (terminal)', () => {
    expect(VALID_TRANSITIONS.Cancelled).toEqual([]);
  });

  it('rejects Expired -> anything (terminal)', () => {
    expect(VALID_TRANSITIONS.Expired).toEqual([]);
  });

  it('rejects Disputed -> Disputed and allows only Completed/Cancelled out of a dispute', () => {
    expect(VALID_TRANSITIONS.Disputed).toEqual(
      expect.arrayContaining(['Completed', 'Cancelled']),
    );
    expect(VALID_TRANSITIONS.Disputed).not.toContain('Disputed');
    expect(VALID_TRANSITIONS.Disputed).not.toContain('Pending');
  });

  it('allows Confirmed to reach Disputed, Completed, or Cancelled, and nothing else', () => {
    expect(new Set(VALID_TRANSITIONS.Confirmed)).toEqual(
      new Set(['Completed', 'Cancelled', 'Disputed']),
    );
  });

  it('has no transition out of an unknown/unrecognized status', () => {
    expect(VALID_TRANSITIONS['NotARealStatus' as keyof typeof VALID_TRANSITIONS]).toBeUndefined();
  });
});
