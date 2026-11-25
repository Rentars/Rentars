import { supabase } from '@/config/supabase.js';
import { normalizeSearchQuery, redactAnalyticsFilters } from '@/utils/searchMetrics.js';
import type { ServiceResponse } from './index.js';

export interface SearchAnalytic {
  id?: string;
  query: string;
  filters?: Record<string, unknown>;
  result_count: number;
  user_id?: string;
  created_at?: string;
}

export interface SearchSuggestion {
  query: string;
  frequency: number;
  result_count?: number;
}

export interface TopQuery {
  query: string;
  frequency: number;
  avg_results?: number;
}

export interface DailyVolume {
  date: string;
  count: number;
}

/**
 * Track a search query for analytics and suggestions (issue #935).
 *
 * Privacy rule: raw queries and personal identifiers are never stored. The
 * query is normalised/redacted, filters are reduced to broad aggregate keys,
 * and the caller's user id is deliberately ignored (searches are anonymous).
 */
export async function trackSearch(
  query: string,
  resultCount: number,
  _userId?: string,
  filters?: Record<string, unknown>,
): Promise<ServiceResponse<SearchAnalytic>> {
  const { data, error } = await supabase
    .from('search_analytics')
    .insert({
      query: normalizeSearchQuery(query) || '[redacted]',
      filters: redactAnalyticsFilters(filters) ?? null,
      result_count: resultCount,
      user_id: null,
      created_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true, data: data as SearchAnalytic };
}

/**
 * Get search suggestions based on frequency and recency.
 */
export async function getSearchSuggestions(
  prefix: string,
  limit = 10,
): Promise<ServiceResponse<SearchSuggestion[]>> {
  if (!prefix || prefix.length < 2) {
    return { success: true, data: [] };
  }

  const { data, error } = await supabase.rpc('get_search_suggestions', {
    search_prefix: `${prefix.toLowerCase()}%`,
    limit,
  });

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true, data: (data ?? []) as SearchSuggestion[] };
}

/**
 * Top queries by frequency over a date range. Index-backed via idx_search_analytics_created_at.
 * Returns normalized query buckets only; cohorts below MIN_AGGREGATION_THRESHOLD are suppressed.
 */
export async function getTopQueries(
  startDate: string,
  endDate: string,
  limit = 20,
  options: AnalyticsQueryOptions = {},
): Promise<ServiceResponse<AggregatedResult<AggregatedTopQuery>>> {
  const windowError = validateTimeWindow(startDate, endDate);
  if (windowError) return { success: false, error: windowError };
  const filterError = validateFilters(options.filters);
  if (filterError) return { success: false, error: filterError };

  const { data, error } = await supabase.rpc('get_top_queries', {
    p_start_date: startDate,
    p_end_date: endDate,
    p_limit: limit,
  });

  if (error) return { success: false, error: error.message };
  return { success: true, data: sanitizeTopQueries((data ?? []) as TopQuery[]) };
}

/** Never expose a raw (potentially personal) query through admin reporting. */
function sanitizeTopQueries(rows: TopQuery[]): TopQuery[] {
  return rows.map((row) => ({ ...row, query: normalizeSearchQuery(row.query) || '[redacted]' }));
}

/**
 * Zero-result queries by frequency over a date range. Index-backed via idx_search_analytics_zero_result.
 * Returns normalized query buckets only; cohorts below MIN_AGGREGATION_THRESHOLD are suppressed.
 */
export async function getZeroResultQueries(
  startDate: string,
  endDate: string,
  limit = 20,
  options: AnalyticsQueryOptions = {},
): Promise<ServiceResponse<AggregatedResult<AggregatedTopQuery>>> {
  const windowError = validateTimeWindow(startDate, endDate);
  if (windowError) return { success: false, error: windowError };
  const filterError = validateFilters(options.filters);
  if (filterError) return { success: false, error: filterError };

  const { data, error } = await supabase.rpc('get_zero_result_queries', {
    p_start_date: startDate,
    p_end_date: endDate,
    p_limit: limit,
  });

  if (error) return { success: false, error: error.message };
  return { success: true, data: sanitizeTopQueries((data ?? []) as TopQuery[]) };
}

/**
 * Delete legacy raw analytics rows belonging to a user (deletion requests).
 * New writes are anonymous, but old rows may still carry a user_id.
 */
export async function deleteSearchAnalyticsForUser(
  userId: string,
): Promise<ServiceResponse<null>> {
  const { error } = await supabase.from('search_analytics').delete().eq('user_id', userId);
  if (error) return { success: false, error: error.message };
  return { success: true, data: null };
}

/**
 * Enforce the approved retention window for raw search events.
 */
export async function deleteSearchAnalyticsBefore(
  cutoff: Date,
): Promise<ServiceResponse<null>> {
  const { error } = await supabase
    .from('search_analytics')
    .delete()
    .lt('created_at', cutoff.toISOString());
  if (error) return { success: false, error: error.message };
  return { success: true, data: null };
}

/**
 * Daily search volume over a date range. Days with fewer than
 * MIN_AGGREGATION_THRESHOLD events are suppressed.
 */
export async function getDailySearchVolume(
  startDate: string,
  endDate: string,
  options: AnalyticsQueryOptions = {},
): Promise<ServiceResponse<AggregatedResult<AggregatedDailyVolume>>> {
  const windowError = validateTimeWindow(startDate, endDate);
  if (windowError) return { success: false, error: windowError };
  const filterError = validateFilters(options.filters);
  if (filterError) return { success: false, error: filterError };

  const { data, error } = await supabase.rpc('get_daily_search_volume', {
    p_start_date: startDate,
    p_end_date: endDate,
  });

  if (error) return { success: false, error: error.message };

  const items: AggregatedDailyVolume[] = ((data ?? []) as DailyVolume[])
    .filter((row) => row.count >= MIN_AGGREGATION_THRESHOLD)
    .map((row) => ({ date: row.date, count: row.count }));

  return {
    success: true,
    data: { items, meta: buildMeta(startDate, endDate, items.length === 0) },
  };
}

/**
 * Record that relaxed-filter suggestions were offered or accepted.
 */
export async function trackSuggestionEvent(
  eventType: 'offered' | 'accepted',
  suggestionType: string,
  originalQuery?: string,
  _userId?: string,
): Promise<void> {
  await supabase.from('search_suggestion_events').insert({
    event_type: eventType,
    suggestion_type: suggestionType,
    original_query: originalQuery ? normalizeSearchQuery(originalQuery) : null,
    user_id: null,
  });
}

/**
 * Get trending searches for the past 7 days. Returns normalized query buckets
 * only; buckets below MIN_AGGREGATION_THRESHOLD are suppressed.
 */
export async function getTrendingSearches(
  limit = 10,
  options: AnalyticsQueryOptions = {},
): Promise<ServiceResponse<AggregatedResult<AggregatedTrendingSearch>>> {
  const filterError = validateFilters(options.filters);
  if (filterError) return { success: false, error: filterError };

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 7);

  const startIso = startDate.toISOString();
  const endIso = endDate.toISOString();

  const { data, error } = await supabase
    .from('search_analytics')
    .select('query')
    .gte('created_at', startIso)
    .lte('created_at', endIso)
    .order('created_at', { ascending: false });

  if (error) {
    return { success: false, error: error.message };
  }

  // Group by normalized bucket and count
  const counts = new Map<string, number>();
  for (const item of (data ?? []) as Array<{ query: string }>) {
    const bucket = normalizeQueryBucket(item.query);
    if (!bucket) continue;
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }

  const items: AggregatedTrendingSearch[] = [];
  for (const [query_bucket, frequency] of counts) {
    if (frequency < MIN_AGGREGATION_THRESHOLD) continue;
    items.push({ query_bucket, frequency });
  }
  items.sort((a, b) => b.frequency - a.frequency);

  return {
    success: true,
    data: {
      items: items.slice(0, limit),
      meta: buildMeta(startIso, endIso, items.length === 0),
    },
  };
}
