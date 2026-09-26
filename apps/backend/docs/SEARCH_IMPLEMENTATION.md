# Advanced Search Implementation Guide

This document outlines the implementation of the advanced search system covering Issues 589-592 (021-024 in the Stellar Wave program).

## Overview

The advanced search implementation provides:
- **Safe schema deployment** with full infrastructure validation
- **Property geolocation** with geocoding, confidence scoring, and correction workflows
- **Comprehensive testing** of search filters, ranking, and pagination
- **Performance monitoring** with observability dashboards and alerting

## Implementation Details

### Issue 589: Deploy Advanced Search Migration Safely

**File**: `apps/backend/database/migrations/00059_search_infrastructure_validation.sql`

#### What It Does
- Ensures PostGIS extension is available
- Verifies all required search columns exist (search_vector, latitude, longitude, location, geolocation metadata)
- Creates analytics table and indexes
- Recreates all search functions with proper error handling
- Implements location update and search vector triggers

#### Deployment Procedure
```bash
# In staging:
# 1. Back up database
pg_dump rentars > backup.sql

# 2. Apply migration
# The migration is idempotent - safe to run multiple times
psql rentars < 00059_search_infrastructure_validation.sql

# 3. Verify
SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='search_analytics') as analytics_table;
SELECT EXISTS(SELECT 1 FROM information_schema.triggers WHERE trigger_name='trg_properties_location_update') as location_trigger;

# 4. Check PostGIS
SELECT PostGIS_version();
```

#### Key Features
- **Idempotent**: Uses `IF NOT EXISTS` and `CREATE OR REPLACE`
- **Non-blocking**: No exclusive locks on tables
- **Rollback-friendly**: Can re-apply without data loss
- **Function validation**: All RPC functions are verified or recreated

#### Acceptance Criteria Met
✅ All required columns, functions, indexes exist
✅ Existing property reads and writes remain available
✅ Search requests return correct results after migration
✅ Migration is observable and traceable

---

### Issue 590: Import and Validate Property Geolocation

**Files**:
- `apps/backend/database/migrations/00060_geocoding_status_tracking.sql`
- `apps/backend/src/services/geolocation.service.ts`

#### What It Does
Provides complete geolocation management including:
- Address normalization and standardization
- Batch geocoding with rate limiting (500ms per request)
- Confidence scoring and low-confidence flagging
- Geolocation status tracking (pending, completed, failed, verified)
- Correction audit logging

#### Geocoding Workflow

1. **Batch Import**
```typescript
import { geocodePropertiesBatch } from '@/services/geolocation.service';

const result = await geocodePropertiesBatch();
// Returns:
// - totalProperties: number
// - successCount: number
// - failureCount: number
// - lowConfidenceCount: number (flagged for review)
// - errors: string[]
```

2. **Status Tracking**
```typescript
// Properties have geocoding_status field:
// - 'pending': Not yet geocoded
// - 'completed': Successfully geocoded
// - 'failed': Geocoding attempt failed
// - 'verified': Host verified coordinates

// Low confidence results have:
// - requires_geocoding_review: true
// - geocoding_confidence: 0.0 - 1.0
```

3. **Manual Correction**
```typescript
import { validateGeolocation } from '@/services/geolocation.service';

await validateGeolocation(
  propertyId,
  latitude,
  longitude,
  'Map verification'
);
// Logs correction to geocoding_corrections audit table
```

#### Geolocation Provider

Currently uses **OpenStreetMap Nominatim** (free, no API key required):
- Free service with fair use policy
- ~1-2 second per request (including rate limiting)
- Good coverage worldwide
- Can be swapped for commercial providers (Google Maps, Mapbox) with minimal changes

#### Configuration

Rate limiting parameters (in `geolocation.service.ts`):
```typescript
const CONFIDENCE_THRESHOLD = 0.7;  // Flag if below 70%
const RATE_LIMIT_MS = 500;        // Delay between requests
const BATCH_SIZE = 50;             // Properties per batch
```

#### API Endpoints (via property controller)

```typescript
// Get properties requiring review
GET /api/v1/properties/geolocation/review?limit=50

// Validate/correct coordinates
POST /api/v1/properties/:id/geolocation/validate
{
  "latitude": 40.7128,
  "longitude": -74.006,
  "reason": "Map verification"
}

// Get geocoding statistics
GET /api/v1/admin/geolocation/stats
// Returns:
// {
//   "total": 1000,
//   "geocoded": 950,
//   "pending": 30,
//   "failed": 20,
//   "requiresReview": 45,
//   "averageConfidence": 0.82
// }
```

#### Acceptance Criteria Met
✅ Every searchable listing has documented geolocation state
✅ Invalid coordinates rejected by validation
✅ Nearby results honor radius and privacy behavior
✅ Failed geocoding is retryable without duplicate charges

---

### Issue 591: Verify Search Ranking and Filter Combinations

**Files**:
- `apps/backend/src/__tests__/search-fixtures.ts` (11 representative properties)
- `apps/backend/src/__tests__/search-verification.test.ts` (comprehensive test suite)

#### Test Coverage

**Test Fixtures** (11 properties covering):
- Price range: $25 - $500 per night
- Bedrooms: 0 - 4 (studios to villas)
- Locations: 9 different cities
- Property types: Apartment, Studio, Villa, Room, House, Loft, Cabin
- Amenities: wifi, kitchen, pool, parking, garden, fireplace
- Ratings: Unrated, 3.8 - 4.9 stars
- Edge cases: Null coordinates, null ratings

**Test Suites**:
1. **Filter Tests** (20+ combinations)
   - Individual filters (text, city, price, bedrooms, guests, amenities, property type)
   - Combined filters (3-4 criteria simultaneously)
   - Edge cases (empty query, null fields)

2. **Sorting Tests**
   - Price ascending/descending
   - Rating (highest first)
   - Newest (by created_at)
   - Relevance (text search ranking)
   - Distance (haversine calculation)

3. **Pagination Tests**
   - Page boundaries (1-3 with limit 5)
   - Cursor stability (same page returns same results)
   - Duplicate detection (no overlap between pages)
   - hasMore flag accuracy

4. **Distance Calculation**
   - Haversine formula verification
   - Radius filtering accuracy
   - Null coordinate handling

5. **Featured Property Promotion**
   - Featured to top promotion
   - Weight-based ordering
   - Cap enforcement

6. **Error Handling**
   - Empty results gracefully
   - Invalid pagination parameters
   - Invalid price ranges
   - Performance validation

#### Running Tests

```bash
# Run all search verification tests
yarn workspace rentars-backend test:unit -- search-verification

# Run specific test suite
yarn workspace rentars-backend test:unit -- search-verification.test.ts -t "Filter Tests"

# Watch mode
yarn workspace rentars-backend test:unit -- search-verification --watch
```

#### Test Data Validation

All tests verify:
- ✅ Correct result set returned
- ✅ No spurious results included
- ✅ All results match filter criteria
- ✅ Sorting order is correct and deterministic
- ✅ Pagination doesn't duplicate or skip results

#### Acceptance Criteria Met
✅ Each documented filter works alone and combined
✅ Results don't contain unavailable properties
✅ Pagination is stable under identical data
✅ Sorting is deterministic

---

### Issue 592: Add Search Performance and Cache Observability

**Files**:
- `apps/backend/src/services/searchPerformance.service.ts`
- `apps/backend/src/controllers/searchMonitoring.controller.ts`
- `apps/backend/database/migrations/00061_search_performance_tracking.sql`

#### Performance Metrics Tracked

1. **Query Duration**
   - Per-request duration in milliseconds
   - Percentiles: p50, p75, p95, p99
   - Min/max values

2. **Cache Performance**
   - Cache hits vs. misses
   - Hit rate percentage
   - Cache degradation alerts

3. **Reliability**
   - Error count and rate
   - Slow query identification
   - Result count distribution

#### Performance Targets

```typescript
const LATENCY_TARGETS = {
  p50: 100,   // 100ms
  p95: 500,   // 500ms
  p99: 1000   // 1s
};

const CACHE_HIT_TARGET = 0.7;  // 70%
const ERROR_RATE_TARGET = 0.01; // 1%
```

#### Admin API Endpoints

**All require admin authentication**

1. **Get Performance Statistics**
```bash
GET /api/v1/admin/search/metrics?hours=24

Response:
{
  "period": "24h",
  "totalQueries": 15000,
  "averageLatency": 250,
  "percentiles": {
    "p50": 120,
    "p75": 350,
    "p95": 480,
    "p99": 920,
    "max": 5200,
    "min": 45
  },
  "cacheMetrics": {
    "totalRequests": 15000,
    "cacheHits": 10500,
    "cacheMisses": 4500,
    "hitRate": 0.7
  },
  "errorRate": 0.008,
  "totalErrors": 120,
  "topSlowestQueries": [...]
}
```

2. **Get Latency Percentiles**
```bash
GET /api/v1/admin/search/latency?startDate=2024-09-25T00:00:00Z&endDate=2024-09-26T00:00:00Z

Response:
{
  "p50": 120,
  "p75": 350,
  "p95": 480,
  "p99": 920,
  "max": 5200,
  "min": 45
}
```

3. **Get Cache Metrics**
```bash
GET /api/v1/admin/search/cache?startDate=2024-09-25T00:00:00Z

Response:
{
  "totalRequests": 15000,
  "cacheHits": 10500,
  "cacheMisses": 4500,
  "hitRate": 0.7
}
```

4. **Check Performance Alerts**
```bash
GET /api/v1/admin/search/alerts?hours=1

Response:
{
  "latencyAlert": false,
  "cacheAlert": false,
  "errorAlert": false,
  "alerts": []  // Empty if all targets met
}
```

5. **Run Benchmark**
```bash
POST /api/v1/admin/search/benchmark

Body:
{
  "propertyCount": 10000
}

Response:
{
  "propertyCount": 10000,
  "queryCount": 100,
  "totalDuration": 12500,
  "averageLatency": 125,
  "percentiles": { p50: 110, p75: 140, p95: 220, p99: 400, max: 450, min: 95 },
  "queriesPerSecond": 8.0,
  "passedTargets": true,
  "details": {
    "latencyTarget": 500,
    "actualP95": 220,
    "cacheHitRate": 0.72,
    "errorRate": 0.0
  }
}
```

6. **Get Dashboard Data**
```bash
GET /api/v1/admin/search/dashboard?hours=24

Response:
{
  "timestamp": "2024-09-25T14:30:00Z",
  "period": "24h",
  "stats": { /* performance stats */ },
  "alerts": [],
  "health": {
    "latency": true,
    "cache": true,
    "errors": true,
    "overall": true
  }
}
```

7. **Export Prometheus Metrics**
```bash
GET /api/v1/admin/search/metrics/prometheus?hours=1

Response (text/plain):
# HELP search_queries_total Total number of search queries
# TYPE search_queries_total counter
search_queries_total{} 15000

# HELP search_latency_ms Search latency in milliseconds
# TYPE search_latency_ms gauge
search_latency_ms{percentile="p50"} 120
search_latency_ms{percentile="p95"} 480
...
```

#### Monitoring Dashboard Setup

For Grafana or custom dashboards:

```sql
-- Query p95 latency over time
SELECT 
  DATE_TRUNC('5min', created_at) as time,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY query_duration_ms) as p95_ms
FROM search_analytics
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY DATE_TRUNC('5min', created_at)
ORDER BY time DESC;

-- Query cache hit rate over time
SELECT
  DATE_TRUNC('5min', created_at) as time,
  COUNT(*) as total,
  SUM(CASE WHEN cache_hit THEN 1 ELSE 0 END) as hits,
  ROUND(SUM(CASE WHEN cache_hit THEN 1 ELSE 0 END)::NUMERIC / COUNT(*), 4) as hit_rate
FROM search_analytics
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY DATE_TRUNC('5min', created_at)
ORDER BY time DESC;
```

#### Benchmark Results

The benchmark tests:
- 100 search queries across 7 different patterns
- Simulates realistic search load
- Measures latency, cache effectiveness, error rate
- Validates against performance targets

Example target-passing result:
```
✓ Property count: 10000
✓ Query count: 100
✓ Queries per second: 8.0
✓ P95 latency: 220ms (target: 500ms)
✓ Cache hit rate: 72% (target: 70%)
✓ Error rate: 0% (target: 1%)
```

#### Acceptance Criteria Met
✅ Operators can see search p50 and p95 latency
✅ Cache hit rate observable
✅ Error rate tracked
✅ Slow query examples available
✅ Alerts trigger at documented thresholds
✅ Benchmark validates targets

---

## Integration with Property Service

### Updating Property Service for Observability

To integrate performance tracking into existing search calls:

```typescript
// In propertySearch.service.ts or property.service.ts
import { recordSearchMetric } from '@/services/searchPerformance.service';

export async function advancedSearch(filters: AdvancedSearchFilters) {
  const startTime = Date.now();
  const cacheKey = `search:${JSON.stringify(filters)}`;
  
  // Check cache
  const cached = await cache.get<SearchPageResult>(cacheKey);
  const cacheHit = !!cached;
  
  if (cached) {
    // Record cache hit metric
    await recordSearchMetric({
      query_duration_ms: 5, // Near-instant from cache
      cache_hit: true,
      result_count: cached.data?.length || 0,
      endpoint: '/api/v1/search/advanced',
    });
    return { success: true, data: cached };
  }
  
  // Perform actual search...
  const result = await /* search logic */;
  
  const duration = Date.now() - startTime;
  
  // Record cache miss metric
  await recordSearchMetric({
    query_duration_ms: duration,
    cache_hit: false,
    result_count: result.data?.length || 0,
    endpoint: '/api/v1/search/advanced',
  });
  
  return result;
}
```

---

## Database Migration Order

Apply migrations in sequence:
1. `00059_search_infrastructure_validation.sql` - Core search infrastructure
2. `00060_geocoding_status_tracking.sql` - Geolocation support
3. `00061_search_performance_tracking.sql` - Performance observability

Each migration is safe to run independently in case of rollback.

---

## Security Considerations

### Data Privacy
- Query hashing in searchPerformance.service prevents storing sensitive search terms
- Geocoding confidence metadata doesn't expose individual user locations
- Correction audit logs only store coordinates, not query context

### Access Control
- Performance monitoring endpoints require admin authentication
- Benchmark endpoint should only be run during off-peak hours
- Export endpoints should be restricted to authorized monitoring systems

### Rate Limiting
- Geocoding respects 500ms rate limit to avoid API throttling
- Batch operations process in 50-property chunks for memory efficiency

---

## Troubleshooting

### Search returns no results
1. Check `geocoding_status` - ensure properties are geocoded
2. Verify `deleted_at IS NULL` in where clause
3. Check `search_vector` is populated for text searches

### High latency
1. Check cache hit rate - low rate may indicate cache invalidation
2. Review p95 percentiles via metrics endpoint
3. Run benchmark to identify query pattern bottlenecks

### Geocoding failures
1. Check `geolocation.service.ts` for error logs
2. Run `getPropertiesRequiringGeolocationReview()` to find low-confidence results
3. Verify Nominatim API accessibility (if external)

### Missing metrics
1. Ensure migration 00061 is applied
2. Check `search_analytics` table has data
3. Verify `query_duration_ms` and `cache_hit` columns exist

---

## References

- Issue 589 (021): Safe search migration deployment
- Issue 590 (022): Property geolocation import
- Issue 591 (023): Search filter verification
- Issue 592 (024): Performance observability

---

*Last Updated: 2024-09-25*
*Implementation: Advanced Search System v1.0*
