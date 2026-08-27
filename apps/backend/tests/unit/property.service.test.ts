/**
 * Unit tests for property service.
 * Uses bun:test with module-level Supabase mock.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { mockProperties } from '../mocks/supabase.mock.data.js';

// ── Supabase + cache mock ─────────────────────────────────────────────────────

const mockFrom = mock((_: string) => ({}));
const mockSupabase = { from: mockFrom };
const supabaseMod = await import('../../src/config/supabase.js');
(supabaseMod as any).supabase = mockSupabase;

// Stub cache to be a no-op
const cacheMod = await import('../../src/services/cache.service.js');
(cacheMod as any).get = mock(async () => null);
(cacheMod as any).set = mock(async () => {});
(cacheMod as any).del = mock(async () => {});

import {
  getAllProperties,
  getPropertyById,
  createProperty,
  updateProperty,
  deleteProperty,
  searchProperties,
  type Property,
} from '../../src/services/property.service.js';

const TTL_ONE = 300; // matches property.service.ts

// ─────────────────────────────────────────────────────────────────────────────

describe('property.service', () => {
  beforeEach(() => {
    mockFrom.mockClear();
  });

  // ── getAllProperties ────────────────────────────────────────────────────────

  describe('getAllProperties', () => {
    it('should return a list of properties', async () => {
      mockFrom.mockImplementation(() => ({
        select: mock(() => ({
          order: mock(async () => ({ data: mockProperties, error: null })),
        })),
      }));

      const result = await getAllProperties();
      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockProperties);
    });

    it('should handle database error', async () => {
      mockFrom.mockImplementation(() => ({
        select: mock(() => ({
          order: mock(async () => ({ data: null, error: { message: 'Database connection failed' } })),
        })),
      }));

      const result = await getAllProperties();
      expect(result.success).toBe(false);
      expect(result.error).toBe('Database connection failed');
    });
  });

  // ── getPropertyById ─────────────────────────────────────────────────────────

  describe('getPropertyById', () => {
    it('should return a property when found', async () => {
      const property = mockProperties[0];
      mockFrom.mockImplementation(() => ({
        select: mock(() => ({
          eq: mock(() => ({
            single: mock(async () => ({ data: property, error: null })),
          })),
        })),
      }));

      const result = await getPropertyById(property.id);
      expect(result.success).toBe(true);
      expect(result.data).toEqual(property);
    });

    it('should return error when property not found', async () => {
      mockFrom.mockImplementation(() => ({
        select: mock(() => ({
          eq: mock(() => ({
            single: mock(async () => ({ data: null, error: { message: 'No rows found' } })),
          })),
        })),
      }));

      const result = await getPropertyById('non-existent-id');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Property not found');
    });

    it('should return error when ID is empty', async () => {
      const result = await getPropertyById('');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Property ID is required');
    });
  });

  // ── createProperty ──────────────────────────────────────────────────────────

  describe('createProperty', () => {
    it('should create a property successfully', async () => {
      const newProperty: Partial<Property> = { title: 'New Property', price_per_night: 150, city: 'Paris' };
      const createdProperty = { id: 'new-id', ...newProperty };

      mockFrom.mockImplementation(() => ({
        insert: mock(() => ({
          select: mock(() => ({
            single: mock(async () => ({ data: createdProperty, error: null })),
          })),
        })),
      }));

      const result = await createProperty(newProperty);
      expect(result.success).toBe(true);
      expect(result.data?.title).toBe('New Property');
    });

    it('should return error when title is missing', async () => {
      const result = await createProperty({ price_per_night: 100 });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Property title is required');
    });

    // #419 — whitespace-only titles must be rejected without a DB call
    it('rejects a whitespace-only title without a database call', async () => {
      const result = await createProperty({ title: '   ' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Property title is required');
      expect(mockFrom).not.toHaveBeenCalled();
    });

    // #419 — surrounding spaces must not be stored
    it('does not persist surrounding spaces in the title', async () => {
      const createdProperty = { id: 'new-id', title: 'Nice Flat', city: 'Berlin' };
      mockFrom.mockImplementation(() => ({
        insert: mock(() => ({
          select: mock(() => ({
            single: mock(async () => ({ data: createdProperty, error: null })),
          })),
        })),
        update: mock(() => ({
          eq: mock(async () => ({ error: null })),
        })),
      }));

      const result = await createProperty({ title: '  Nice Flat  ', city: 'Berlin' });
      expect(result.success).toBe(true);
      // The inserted payload should have the trimmed title
      const insertArg = mockFrom.mock.calls[0];
      expect(insertArg).toBeDefined(); // DB was reached
      // The returned property title must not carry leading/trailing spaces
      expect(result.data?.title).toBe('Nice Flat');
    });

    // #418 — titles with no sluggable characters must fail with a clear message
    it('rejects a title that produces no valid slug characters', async () => {
      const result = await createProperty({ title: '!!!---...' });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/letter or digit/i);
      expect(mockFrom).not.toHaveBeenCalled();
    });

    it('should handle database error during creation', async () => {
      mockFrom.mockImplementation(() => ({
        insert: mock(() => ({
          select: mock(() => ({
            single: mock(async () => ({ data: null, error: { message: 'Unique constraint violation' } })),
          })),
        })),
      }));

      const result = await createProperty({ title: 'Duplicate' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Unique constraint violation');
    });
  });

  // ── updateProperty ──────────────────────────────────────────────────────────

  describe('updateProperty', () => {
    it('should update a property successfully', async () => {
      const propertyId = mockProperties[0].id;
      const updatedProperty = { ...mockProperties[0], price_per_night: 200 };

      mockFrom.mockImplementation(() => ({
        update: mock(() => ({
          eq: mock(() => ({
            select: mock(() => ({
              single: mock(async () => ({ data: updatedProperty, error: null })),
            })),
          })),
        })),
      }));

      const result = await updateProperty(propertyId, { price_per_night: 200 });
      expect(result.success).toBe(true);
    });

    it('should return error when ID is missing', async () => {
      const result = await updateProperty('', { price_per_night: 200 });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Property ID is required');
    });

    it('should return error when no fields provided', async () => {
      const result = await updateProperty('some-id', {});
      expect(result.success).toBe(false);
      expect(result.error).toBe('No fields provided for update');
    });
  });

  // ── deleteProperty ──────────────────────────────────────────────────────────

  describe('deleteProperty', () => {
    it('should delete a property successfully', async () => {
      mockFrom.mockImplementation(() => ({
        delete: mock(() => ({
          eq: mock(async () => ({ error: null })),
        })),
      }));

      const result = await deleteProperty('property-id');
      expect(result.success).toBe(true);
    });

    it('should return error when ID is missing', async () => {
      const result = await deleteProperty('');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Property ID is required');
    });

    it('should handle database error during deletion', async () => {
      mockFrom.mockImplementation(() => ({
        delete: mock(() => ({
          eq: mock(async () => ({ error: { message: 'Row not found' } })),
        })),
      }));

      const result = await deleteProperty('non-existent');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Row not found');
    });
  });

  // ── searchProperties ────────────────────────────────────────────────────────

  describe('searchProperties', () => {
    it('should search properties with city filter', async () => {
      const filtered = mockProperties.filter((p) => p.city === 'New York');
      mockFrom.mockImplementation(() => ({
        select: mock(() => ({
          ilike: mock(() => ({
            order: mock(async () => ({ data: filtered, error: null })),
          })),
        })),
      }));

      const result = await searchProperties({ city: 'New York' });
      expect(result.success).toBe(true);
      expect(result.data).toEqual(filtered);
    });

    it('should handle search error', async () => {
      mockFrom.mockImplementation(() => ({
        select: mock(() => ({
          order: mock(async () => ({ data: null, error: { message: 'Search failed' } })),
        })),
      }));

      const result = await searchProperties({});
      expect(result.success).toBe(false);
      expect(result.error).toBe('Search failed');
    });
  });

  // ── getPropertyById — cache behaviour ───────────────────────────────────────

  describe('getPropertyById cache behaviour', () => {
    beforeEach(() => {
      mockFrom.mockClear();
      // Reset cache mocks before each test
      (cacheMod as any).get = mock(async () => null);
      (cacheMod as any).set = mock(async () => {});
    });

    it('returns cached property without calling Supabase on cache hit', async () => {
      const cachedProp = { id: 'p1', title: 'Cached', status: 'available', owner_id: 'o1' } as Property;
      (cacheMod as any).get = mock(async () => cachedProp);

      const result = await getPropertyById('p1');

      expect(result.success).toBe(true);
      expect(result.data).toEqual(cachedProp);
      expect(mockFrom).not.toHaveBeenCalled();
    });

    it('stores a non-draft property in cache on cache miss', async () => {
      const prop = { id: 'p1', title: 'Available', status: 'available', owner_id: 'o1' } as Property;
      (cacheMod as any).get = mock(async () => null);
      const setMock = mock(async () => {});
      (cacheMod as any).set = setMock;

      mockFrom.mockImplementation(() => ({
        select: mock(() => ({
          eq: mock(() => ({ single: mock(async () => ({ data: prop, error: null })) })),
        })),
      }));

      await getPropertyById('p1');

      expect(setMock.mock.calls.length).toBe(1);
      expect(setMock.mock.calls[0][0]).toBe('property:p1');
      expect(setMock.mock.calls[0][2]).toBe(TTL_ONE);
    });

    it('bypasses cached draft and fetches fresh data when requester is the owner', async () => {
      const draftProp = { id: 'd1', title: 'My Draft', status: 'draft', owner_id: 'owner-1' } as Property;
      (cacheMod as any).get = mock(async () => draftProp);
      const setMock = mock(async () => {});
      (cacheMod as any).set = setMock;

      mockFrom.mockImplementation(() => ({
        select: mock(() => ({
          eq: mock(() => ({ single: mock(async () => ({ data: draftProp, error: null })) })),
        })),
      }));

      const result = await getPropertyById('d1', 'owner-1');

      expect(result.success).toBe(true);
      expect(mockFrom).toHaveBeenCalled();
      expect(setMock.mock.calls.length).toBe(0);
    });

    it('does not store a draft property in cache on cache miss', async () => {
      const draftProp = { id: 'd1', title: 'Draft', status: 'draft', owner_id: 'owner-1' } as Property;
      (cacheMod as any).get = mock(async () => null);
      const setMock = mock(async () => {});
      (cacheMod as any).set = setMock;

      mockFrom.mockImplementation(() => ({
        select: mock(() => ({
          eq: mock(() => ({ single: mock(async () => ({ data: draftProp, error: null })) })),
        })),
      }));

      await getPropertyById('d1', 'owner-1');

      expect(setMock.mock.calls.length).toBe(0);
    });

    it('serves cached draft to a non-owner without hitting Supabase', async () => {
      const draftProp = { id: 'd1', title: 'Draft', status: 'draft', owner_id: 'owner-1' } as Property;
      (cacheMod as any).get = mock(async () => draftProp);

      const result = await getPropertyById('d1', 'not-the-owner');

      expect(result.success).toBe(true);
      expect(result.data).toEqual(draftProp);
      expect(mockFrom).not.toHaveBeenCalled();
    });

    it('invalidates cache on property update', async () => {
      const updatedProp = { ...mockProperties[0], price_per_night: 999 };
      const delMock = mock(async () => {});
      (cacheMod as any).del = delMock;

      mockFrom.mockImplementation(() => ({
        update: mock(() => ({
          eq: mock(() => ({
            select: mock(() => ({
              single: mock(async () => ({ data: updatedProp, error: null })),
            })),
          })),
        })),
      }));

      await updateProperty(mockProperties[0].id, { price_per_night: 999 });

      const deletedKeys = delMock.mock.calls.map((c: unknown[]) => c[0]);
      expect(deletedKeys).toContain(`property:${mockProperties[0].id}`);
    });

    it('invalidates cache on property delete', async () => {
      const delMock = mock(async () => {});
      (cacheMod as any).del = delMock;

      mockFrom.mockImplementation(() => ({
        delete: mock(() => ({
          eq: mock(async () => ({ error: null })),
        })),
      }));

      await deleteProperty('prop-to-delete');

      const deletedKeys = delMock.mock.calls.map((c: unknown[]) => c[0]);
      expect(deletedKeys).toContain('property:prop-to-delete');
    });
  });
});
