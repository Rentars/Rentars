/**
 * Property types — re-exported from the canonical Zod schema.
 *
 * Import from @/lib/api-schemas/property.schema to access the Zod validators.
 * This file re-exports the inferred TypeScript types for backwards compatibility.
 */

export type {
  PropertyStatus,
  PropertyType,
  PropertyImage,
  PropertySearchResult as Property,
  AdvancedSearchResponse,
} from '@/lib/api-schemas/property.schema';

export {
  PropertyStatusSchema,
  PropertyTypeSchema,
  PropertySearchResultSchema,
  AdvancedSearchResponseSchema,
} from '@/lib/api-schemas/property.schema';

// ── Utility helpers ───────────────────────────────────────────────────────────

import type { PropertySearchResult } from '@/lib/api-schemas/property.schema';

/**
 * Build the canonical URL path for a property.
 *
 * Prefer the slug when available (SEO-friendly), fall back to the UUID
 * for backwards-compatibility with properties that pre-date migration 00024.
 *
 * @example
 *   propertyPath({ id: 'abc', slug: 'cozy-loft-paris-a1b2c3' })
 *   // → '/property/cozy-loft-paris-a1b2c3'
 *
 *   propertyPath({ id: 'abc' })
 *   // → '/property/abc'
 */
export function propertyPath(
  property: Pick<PropertySearchResult, 'id' | 'slug'>,
): string {
  return `/property/${property.slug ?? property.id}`;
}
