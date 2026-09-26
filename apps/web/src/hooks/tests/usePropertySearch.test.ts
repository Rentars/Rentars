import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePropertySearch } from '../usePropertySearch';

describe('usePropertySearch', () => {
  it('initializes with empty results and no loading', () => {
    const { result } = renderHook(() => usePropertySearch());

    expect(result.current.results).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.hasMore).toBe(false);
    expect(result.current.total).toBe(0);
  });

  it('exports search, loadMore, and other functions', () => {
    const { result } = renderHook(() => usePropertySearch());

    expect(typeof result.current.search).toBe('function');
    expect(typeof result.current.loadMore).toBe('function');
    expect(typeof result.current.searchByBounds).toBe('function');
    expect(typeof result.current.getSuggestions).toBe('function');
    expect(typeof result.current.getTrending).toBe('function');
  });
});
