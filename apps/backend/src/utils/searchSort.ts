/**
 * Sort clauses for property search results (issue #749).
 *
 * Every clause list ends with the unique `id` column. Without it, listings that
 * share a price, rating or creation timestamp have no defined order, so
 * consecutive pages can repeat or skip items. Adding `id` makes the order total
 * and therefore stable across pages for unchanged data.
 */

export interface SearchOrderOptions {
  ascending: boolean;
  nullsFirst?: boolean;
}

export interface SearchOrderClause {
  column: string;
  options: SearchOrderOptions;
}

export function buildSearchOrderClauses(sortBy: string | undefined): SearchOrderClause[] {
  const clauses: SearchOrderClause[] = [];

  switch (sortBy) {
    case 'price_asc':
      clauses.push({ column: 'price_per_night', options: { ascending: true } });
      break;
    case 'price_desc':
      clauses.push({ column: 'price_per_night', options: { ascending: false } });
      break;
    case 'rating':
      clauses.push(
        { column: 'average_rating', options: { ascending: false, nullsFirst: false } },
        { column: 'review_count', options: { ascending: false, nullsFirst: false } }
      );
      break;
    default:
      clauses.push({ column: 'created_at', options: { ascending: false } });
      break;
  }

  clauses.push({ column: 'id', options: { ascending: true } });
  return clauses;
}
