/**
 * Unit tests for availability service.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ── Supabase mock ─────────────────────────────────────────────────────────────

const mockFrom = mock((_: string) => ({}));
const mockSupabase = { from: mockFrom };

const supabaseMod = await import('../../src/config/supabase.js');
(supabaseMod as any).supabase = mockSupabase;

import {
  getAvailabilityRanges,
  blockAvailabilityRange,
  deleteAvailabilityRange,
  isDateRangeAvailable,
  nightsBetween,
} from '../../src/services/availability.service.js';

// ─────────────────────────────────────────────────────────────────────────────

describe('availability.service', () => {
  beforeEach(() => {
    mockFrom.mockClear();
  });

  // ── getAvailabilityRanges ───────────────────────────────────────────────────

  describe('getAvailabilityRanges', () => {
    it('should return ranges for a property', async () => {
      const ranges = [
        { id: 'r1', property_id: 'p1', start_date: '2026-07-01', end_date: '2026-07-10', is_available: false },
      ];

      mockFrom.mockImplementation(() => ({
        select: mock(() => ({
          eq: mock(() => ({
            order: mock(async () => ({ data: ranges, error: null })),
          })),
        })),
      }));

      const result = await getAvailabilityRanges('p1');
      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(1);
    });

    it('should return error on DB failure', async () => {
      mockFrom.mockImplementation(() => ({
        select: mock(() => ({
          eq: mock(() => ({
            order: mock(async () => ({ data: null, error: { message: 'DB error' } })),
          })),
        })),
      }));

      const result = await getAvailabilityRanges('p1');
      expect(result.success).toBe(false);
    });
  });

  // ── blockAvailabilityRange ──────────────────────────────────────────────────

  describe('blockAvailabilityRange', () => {
    const ownerId = 'owner-1';
    const propertyId = 'prop-1';

    it('should block a date range when caller is owner', async () => {
      const newRange = {
        id: 'range-1',
        property_id: propertyId,
        start_date: '2026-08-01',
        end_date: '2026-08-10',
        is_available: false,
      };

      mockFrom.mockImplementation((table: string) => {
        if (table === 'properties') {
          return {
            select: mock(() => ({
              eq: mock(() => ({
                single: mock(async () => ({ data: { owner_id: ownerId }, error: null })),
              })),
            })),
          };
        }
        return {
          insert: mock(() => ({
            select: mock(() => ({
              single: mock(async () => ({ data: newRange, error: null })),
            })),
          })),
        };
      });

      const result = await blockAvailabilityRange(propertyId, ownerId, {
        start_date: '2026-08-01',
        end_date: '2026-08-10',
        reason: 'Maintenance',
      });

      expect(result.success).toBe(true);
      expect(result.data?.is_available).toBe(false);
    });

    it('should return error when caller is not the owner', async () => {
      mockFrom.mockImplementation((table: string) => {
        if (table === 'properties') {
          return {
            select: mock(() => ({
              eq: mock(() => ({
                single: mock(async () => ({ data: { owner_id: 'different-owner' }, error: null })),
              })),
            })),
          };
        }
        return {};
      });

      const result = await blockAvailabilityRange(propertyId, ownerId, {
        start_date: '2026-08-01',
        end_date: '2026-08-10',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Forbidden');
    });

    it('should return error when property not found', async () => {
      mockFrom.mockImplementation(() => ({
        select: mock(() => ({
          eq: mock(() => ({
            single: mock(async () => ({ data: null, error: null })),
          })),
        })),
      }));

      const result = await blockAvailabilityRange(propertyId, ownerId, {
        start_date: '2026-08-01',
        end_date: '2026-08-10',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Property not found');
    });

    it('should return error for invalid date format', async () => {
      mockFrom.mockImplementation((table: string) => {
        if (table === 'properties') {
          return {
            select: mock(() => ({
              eq: mock(() => ({
                single: mock(async () => ({ data: { owner_id: ownerId }, error: null })),
              })),
            })),
          };
        }
        return {};
      });

      const result = await blockAvailabilityRange(propertyId, ownerId, {
        start_date: 'not-a-date',
        end_date: 'also-not-a-date',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid date format');
    });

    it('should return error when start_date >= end_date', async () => {
      mockFrom.mockImplementation((table: string) => {
        if (table === 'properties') {
          return {
            select: mock(() => ({
              eq: mock(() => ({
                single: mock(async () => ({ data: { owner_id: ownerId }, error: null })),
              })),
            })),
          };
        }
        return {};
      });

      const result = await blockAvailabilityRange(propertyId, ownerId, {
        start_date: '2026-08-10',
        end_date: '2026-08-01', // end before start
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('start_date must be before end_date');
    });
  });

  // ── deleteAvailabilityRange ─────────────────────────────────────────────────

  describe('deleteAvailabilityRange', () => {
    it('should delete a range when caller is owner', async () => {
      mockFrom.mockImplementation((table: string) => {
        if (table === 'properties') {
          return {
            select: mock(() => ({
              eq: mock(() => ({
                single: mock(async () => ({ data: { owner_id: 'owner-1' }, error: null })),
              })),
            })),
          };
        }
        return {
          delete: mock(() => ({
            eq: mock(() => ({
              eq: mock(async () => ({ error: null })),
            })),
          })),
        };
      });

      const result = await deleteAvailabilityRange('p1', 'r1', 'owner-1');
      expect(result.success).toBe(true);
    });

    it('should return error when caller is not owner', async () => {
      mockFrom.mockImplementation(() => ({
        select: mock(() => ({
          eq: mock(() => ({
            single: mock(async () => ({ data: { owner_id: 'real-owner' }, error: null })),
          })),
        })),
      }));

      const result = await deleteAvailabilityRange('p1', 'r1', 'not-owner');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Forbidden');
    });
  });

  // ── isDateRangeAvailable ────────────────────────────────────────────────────

  describe('isDateRangeAvailable', () => {
    it('should return true when no blocking ranges overlap', async () => {
      mockFrom.mockImplementation(() => ({
        select: mock(() => ({
          eq: mock(() => ({
            eq: mock(() => ({
              lt: mock(() => ({
                gt: mock(() => ({
                  limit: mock(async () => ({ data: [], error: null })),
                })),
              })),
            })),
          })),
        })),
      }));

      const available = await isDateRangeAvailable('p1', '2026-09-01', '2026-09-07');
      expect(available).toBe(true);
    });

    it('should return false when a blocking range exists', async () => {
      mockFrom.mockImplementation(() => ({
        select: mock(() => ({
          eq: mock(() => ({
            eq: mock(() => ({
              lt: mock(() => ({
                gt: mock(() => ({
                  limit: mock(async () => ({
                    data: [{ id: 'block-1' }],
                    error: null,
                  })),
                })),
              })),
            })),
          })),
        })),
      }));

      const available = await isDateRangeAvailable('p1', '2026-08-01', '2026-08-10');
      expect(available).toBe(false);
    });
  });

  // ── blockAvailabilityRange — booking overlap guard (#267) ───────────────────

  describe('blockAvailabilityRange — booking overlap guard', () => {
    const ownerId = 'owner-1';
    const propertyId = 'prop-1';

    it('should reject blocking a range that overlaps a confirmed booking', async () => {
      mockFrom.mockImplementation((table: string) => {
        if (table === 'properties') {
          return {
            select: mock(() => ({
              eq: mock(() => ({
                single: mock(async () => ({ data: { owner_id: ownerId }, error: null })),
              })),
            })),
          };
        }
        if (table === 'bookings') {
          return {
            select: mock(() => ({
              eq: mock(() => ({
                in: mock(() => ({
                  lt: mock(() => ({
                    gt: mock(() => ({
                      limit: mock(async () => ({ data: [{ id: 'booking-confirmed' }], error: null })),
                    })),
                  })),
                })),
              })),
            })),
          };
        }
        return {};
      });

      const result = await blockAvailabilityRange(propertyId, ownerId, {
        start_date: '2026-09-01',
        end_date: '2026-09-10',
        reason: 'maintenance',
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/existing booking/i);
    });

    it('should succeed when no bookings overlap the blocked range', async () => {
      const newRange = {
        id: 'range-new',
        property_id: propertyId,
        start_date: '2026-10-01',
        end_date: '2026-10-10',
        is_available: false,
      };

      mockFrom.mockImplementation((table: string) => {
        if (table === 'properties') {
          return {
            select: mock(() => ({
              eq: mock(() => ({
                single: mock(async () => ({ data: { owner_id: ownerId }, error: null })),
              })),
            })),
          };
        }
        if (table === 'bookings') {
          return {
            select: mock(() => ({
              eq: mock(() => ({
                in: mock(() => ({
                  lt: mock(() => ({
                    gt: mock(() => ({
                      limit: mock(async () => ({ data: [], error: null })),
                    })),
                  })),
                })),
              })),
            })),
          };
        }
        return {
          insert: mock(() => ({
            select: mock(() => ({
              single: mock(async () => ({ data: newRange, error: null })),
            })),
          })),
        };
      });

      const result = await blockAvailabilityRange(propertyId, ownerId, {
        start_date: '2026-10-01',
        end_date: '2026-10-10',
        reason: 'Personal use',
      });

      expect(result.success).toBe(true);
      expect(result.data?.is_available).toBe(false);
    });

    it('should prevent a new booking on a host-blocked range (via isDateRangeAvailable)', async () => {
      // When a host-blocked range exists, isDateRangeAvailable returns false
      mockFrom.mockImplementation(() => ({
        select: mock(() => ({
          eq: mock(() => ({
            eq: mock(() => ({
              lt: mock(() => ({
                gt: mock(() => ({
                  limit: mock(async () => ({
                    data: [{ id: 'block-host' }],
                    error: null,
                  })),
                })),
              })),
            })),
          })),
        })),
      }));

      const available = await isDateRangeAvailable('prop-1', '2026-10-01', '2026-10-10');
      expect(available).toBe(false);
    });
  });
});

// ── nightsBetween — DST boundary (#414) ────────────────────────────────────

describe('nightsBetween', () => {
  it('adjacent calendar dates always produce 1 night', () => {
    expect(nightsBetween(new Date('2026-03-08'), new Date('2026-03-09'))).toBe(1);
  });

  it('returns 1 night even when time components cross a DST offset', () => {
    // Spring-forward day: local midnight UTC-5 → UTC-4; difference is 23 h in wall-clock time.
    // UTC floor ensures we count calendar days, not elapsed hours.
    const checkIn = new Date('2026-03-08T05:00:00Z');  // midnight US/Eastern before spring forward
    const checkOut = new Date('2026-03-09T04:00:00Z'); // midnight US/Eastern after spring forward
    expect(nightsBetween(checkIn, checkOut)).toBe(1);
  });

  it('returns 1 night even when the interval is 25 h (fall-back day)', () => {
    // Fall-back day: local midnight UTC-4 → UTC-5; difference is 25 h in wall-clock time.
    const checkIn = new Date('2026-11-01T04:00:00Z');  // midnight US/Eastern before fall back
    const checkOut = new Date('2026-11-02T05:00:00Z'); // midnight US/Eastern after fall back
    expect(nightsBetween(checkIn, checkOut)).toBe(1);
  });

  it('returns the correct count for a multi-night range', () => {
    expect(nightsBetween(new Date('2026-06-01'), new Date('2026-06-08'))).toBe(7);
  });
});

// ── isDateRangeAvailable — ordering guard (#413) ────────────────────────────

describe('isDateRangeAvailable — ordering guard', () => {
  it('returns false for equal check-in and check-out without querying the DB', async () => {
    const available = await isDateRangeAvailable('prop-1', '2026-09-01', '2026-09-01');
    expect(available).toBe(false);
  });

  it('returns false for reversed dates (check-out before check-in) without querying the DB', async () => {
    const available = await isDateRangeAvailable('prop-1', '2026-09-10', '2026-09-01');
    expect(available).toBe(false);
  });
});
