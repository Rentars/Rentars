/**
 * Canonical Zod schemas for Property API shapes.
 *
 * These are the single source of truth for every property-related request and
 * response boundary.  The backend validators, the contract tests, and the
 * frontend runtime parser all import from this file (or its web mirror).
 *
 * Keep in sync with openapi.json #/components/schemas/Property*.
 */

import { z } from 'zod';

// ── Enums ─────────────────────────────────────────────────────────────────────

export const PropertyStatusSchema = z.enum(['available', 'unavailable', 'draft', 'pending']);

export const PropertyTypeSchema = z.enum([
  'Apartment',
  'House',
  'Villa',
  'Condo',
  'Studio',
  'Room',
  'Townhouse',
  'Cabin',
  'Loft',
  'Boat',
]);

export const SortBySchema = z.enum([
  'price_asc',
  'price_desc',
  'newest',
  'distance',
  'relevance',
]);

// ── Sub-shapes ────────────────────────────────────────────────────────────────

export const PropertyImageSchema = z.object({
  id: z.string().uuid(),
  url: z.string().url(),
  is_primary: z.boolean().optional(),
  display_order: z.number().int().min(0).optional(),
});

export const PriceHistogramBucketSchema = z.object({
  min: z.number(),
  max: z.number(),
  count: z.number().int().min(0),
});

export const PriceHistogramResultSchema = z.object({
  buckets: z.array(PriceHistogramBucketSchema),
  global_min: z.number(),
  global_max: z.number(),
});

export const ZeroResultSuggestionTypeSchema = z.enum([
  'no_amenities',
  'wider_price',
  'expand_radius',
  'any_location',
]);

export const ZeroResultSuggestionSchema = z.object({
  type: ZeroResultSuggestionTypeSchema,
  description: z.string(),
  estimated_results: z.number().int().min(0),
  relaxed_filters: z.record(z.unknown()).optional(),
});

// ── Property search result row ────────────────────────────────────────────────

export const PropertySearchResultSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  description: z.string().optional(),
  price_per_night: z.number().min(0),
  city: z.string().optional(),
  country: z.string().optional(),
  address: z.string().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  bedrooms: z.number().int().min(0).optional(),
  bathrooms: z.number().int().min(0).optional(),
  max_guests: z.number().int().min(1).optional(),
  amenities: z.array(z.string()).optional(),
  images: z.array(PropertyImageSchema).optional(),
  owner_id: z.string().uuid().optional(),
  slug: z.string().optional(),
  status: PropertyStatusSchema,
  is_featured: z.boolean().optional(),
  featured_until: z.string().datetime().nullable().optional(),
  created_at: z.string().datetime().optional(),
  updated_at: z.string().datetime().optional(),
});

// ── Advanced search response envelope ────────────────────────────────────────

export const AdvancedSearchResponseSchema = z.object({
  data: z.array(PropertySearchResultSchema),
  total: z.number().int().min(0).optional(),
  page: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).optional(),
  price_histogram: PriceHistogramResultSchema.optional(),
  _suggestions: z.array(ZeroResultSuggestionSchema).optional(),
});

// ── Type exports ──────────────────────────────────────────────────────────────

export type PropertyStatus = z.infer<typeof PropertyStatusSchema>;
export type PropertyType = z.infer<typeof PropertyTypeSchema>;
export type PropertyImage = z.infer<typeof PropertyImageSchema>;
export type PriceHistogramBucket = z.infer<typeof PriceHistogramBucketSchema>;
export type PriceHistogramResult = z.infer<typeof PriceHistogramResultSchema>;
export type ZeroResultSuggestionType = z.infer<typeof ZeroResultSuggestionTypeSchema>;
export type ZeroResultSuggestion = z.infer<typeof ZeroResultSuggestionSchema>;
export type PropertySearchResult = z.infer<typeof PropertySearchResultSchema>;
export type AdvancedSearchResponse = z.infer<typeof AdvancedSearchResponseSchema>;
