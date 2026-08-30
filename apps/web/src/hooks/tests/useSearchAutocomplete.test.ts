import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
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

  it('debounces geocode requests', async () => {
    const onSearch = vi.fn();
    const { result } = renderHook(() => useSearchAutocomplete({ onSearch }));

    act(() => {
      result.current.setInput('New York');
    });

    expect(mockFetch).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('caches geocode results and avoids re-fetch', async () => {
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

    expect(mockFetch).toHaveBeenCalledTimes(1);

    const { result: result2 } = renderHook(() => useSearchAutocomplete({ onSearch }));
    act(() => {
      result2.current.setInput('New York');
    });

    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does not fetch when input is only whitespace', async () => {
    const onSearch = vi.fn();
    const { result } = renderHook(() => useSearchAutocomplete({ onSearch }));

    act(() => {
      result.current.setInput('   ');
    });

    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.current.suggestions).toHaveLength(0);
  });

  it('does not fetch for single character input', async () => {
    const onSearch = vi.fn();
    const { result } = renderHook(() => useSearchAutocomplete({ onSearch }));

    act(() => {
      result.current.setInput('N');
    });

    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.current.suggestions).toHaveLength(0);
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

    expect(result.current.suggestions).toHaveLength(1);

    act(() => {
      result.current.setInput('');
    });

    expect(result.current.suggestions).toHaveLength(0);
  });

  it('prevents in-flight request from repopulating cleared suggestions', async () => {
    const onSearch = vi.fn();
    const { result } = renderHook(() => useSearchAutocomplete({ onSearch }));

    let resolveFirstFetch: ((value: any) => void) | null = null;
    mockFetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirstFetch = resolve;
        }),
    );

    act(() => {
      result.current.setInput('New');
    });

    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.setInput('');
    });

    expect(result.current.suggestions).toHaveLength(0);

    if (resolveFirstFetch) {
      await act(async () => {
        resolveFirstFetch({
          ok: true,
          json: () => Promise.resolve({ address: 'New York, NY' }),
        });
      });
    }

    expect(result.current.suggestions).toHaveLength(0);
  });
});
