/**
 * Search types — re-exported from the canonical Zod schema.
 *
 * Import from @/lib/api-schemas/property.schema to access the Zod validators.
 */

export type {
  PriceHistogramBucket,
  PriceHistogramResult as PriceHistogramResult,
  ZeroResultSuggestion,
  AdvancedSearchResponse,
} from '@/lib/api-schemas/property.schema';

export {
  PriceHistogramBucketSchema,
  PriceHistogramResultSchema,
  ZeroResultSuggestionSchema,
  AdvancedSearchResponseSchema,
} from '@/lib/api-schemas/property.schema';
