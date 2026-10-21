import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAsyncAction } from '../useAsyncAction';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useAsyncAction', () => {
  it('runs the action, returns its result, and reports success', async () => {
    const onSuccess = vi.fn();
    const { result } = renderHook(() =>
      useAsyncAction(async (n: number) => n * 2, { onSuccess }),
    );

    let out: number | undefined;
    await act(async () => {
      out = await result.current.run(21);
    });

    expect(out).toBe(42);
    expect(onSuccess).toHaveBeenCalledWith(42);
    expect(result.current.isPending).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('exposes a pending state while the action is in flight', async () => {
    const d = deferred<string>();
    const { result } = renderHook(() => useAsyncAction(() => d.promise));

    act(() => {
      void result.current.run();
    });
    expect(result.current.isPending).toBe(true);

    await act(async () => {
      d.resolve('done');
    });
    expect(result.current.isPending).toBe(false);
  });

  it('rejects re-entry while in flight (synchronous duplicate guard)', async () => {
    const d = deferred<string>();
    const action = vi.fn(() => d.promise);
    const { result } = renderHook(() => useAsyncAction(action));

    // Both calls land in the same tick — before React can re-render a
    // disabled button — and the second must be a no-op.
    act(() => {
      void result.current.run();
      void result.current.run();
    });
    expect(action).toHaveBeenCalledTimes(1);
    expect(result.current.isPending).toBe(true);

    await act(async () => {
      d.resolve('first');
    });
    expect(result.current.isPending).toBe(false);

    // Once settled, the guard clears and the action may run again.
    await act(async () => {
      await result.current.run();
    });
    expect(action).toHaveBeenCalledTimes(2);
  });

  it('captures the failure message without throwing to the caller', async () => {
    const err = new Error('boom');
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useAsyncAction(() => Promise.reject(err), { onError }),
    );

    let out: unknown = 'sentinel';
    await act(async () => {
      out = await result.current.run();
    });

    expect(out).toBeUndefined();
    expect(result.current.error).toBe('boom');
    expect(result.current.isPending).toBe(false);
    expect(onError).toHaveBeenCalledWith(err);
  });

  it('falls back to a generic message for non-Error rejections', async () => {
    const { result } = renderHook(() => useAsyncAction(() => Promise.reject('network down')));

    await act(async () => {
      await result.current.run();
    });

    expect(result.current.error).toBe('Something went wrong. Please try again.');
  });

  it('clears a captured error when a new run starts', async () => {
    const action = vi
      .fn()
      .mockRejectedValueOnce(new Error('first failed'))
      .mockResolvedValueOnce('ok');
    const { result } = renderHook(() => useAsyncAction(action));

    await act(async () => {
      await result.current.run();
    });
    expect(result.current.error).toBe('first failed');

    await act(async () => {
      await result.current.run();
    });
    expect(result.current.error).toBeNull();
    expect(result.current.isPending).toBe(false);
  });

  it('reset() clears error and pending state', async () => {
    const { result } = renderHook(() => useAsyncAction(() => Promise.reject(new Error('nope'))));

    await act(async () => {
      await result.current.run();
    });
    expect(result.current.error).toBe('nope');

    act(() => {
      result.current.reset();
    });
    expect(result.current.error).toBeNull();
    expect(result.current.isPending).toBe(false);
  });

  it('keeps run referentially stable across renders', () => {
    const { result, rerender } = renderHook(() => useAsyncAction(async () => 'ok'));

    const before = result.current.run;
    rerender();
    expect(result.current.run).toBe(before);
  });
});
