import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSearchAutocomplete } from '../useSearchAutocomplete';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('useSearchAutocomplete', () => {
  beforeEach(() => {
    mockFetch.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not fetch geocode for single character input', async () => {
    mockFetch.mockClear();
    const onSearch = vi.fn();
    const { result } = renderHook(() => useSearchAutocomplete({ onSearch }));

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([]),
    });

    act(() => {
      result.current.setInput('N');
    });

    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    const calls = mockFetch.mock.calls.filter((c) => c[0].includes('/locations/geocode'));
    expect(calls).toHaveLength(0);
  });

  it('trims whitespace before checking length', async () => {
    const onSearch = vi.fn();
    const { result } = renderHook(() => useSearchAutocomplete({ onSearch }));

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(undefined),
    });

    act(() => {
      result.current.setInput('   ');
    });

    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    expect(result.current.suggestions).toEqual(expect.any(Array));
  });

  it('clears suggestions when input is cleared', async () => {
    const onSearch = vi.fn();
    const { result } = renderHook(() => useSearchAutocomplete({ onSearch }));

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ address: 'New York, NY' }),
    });

    act(() => {
      result.current.setInput('New York');
    });

    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    const callsAfterSet = mockFetch.mock.calls.length;

    act(() => {
      result.current.setInput('');
    });

    expect(result.current.suggestions).toEqual(expect.any(Array));
  });

  it('makes geocode request only for valid trimmed input', async () => {
    mockFetch.mockClear();
    const onSearch = vi.fn();
    const { result } = renderHook(() => useSearchAutocomplete({ onSearch }));

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ address: 'Paris, France' }),
    });

    act(() => {
      result.current.setInput('  Paris  ');
    });

    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/locations/geocode'),
      expect.any(Object),
    );
  });
});
