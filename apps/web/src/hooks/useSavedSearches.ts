'use client';

import { useCallback, useEffect, useState } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
const API_BASE = `${API_URL}/api/v1/saved-searches`;

export type DigestFrequency = 'immediate' | 'daily' | 'weekly';

export interface SavedSearch {
  id: string;
  user_id: string;
  name: string;
  filters: Record<string, unknown>;
  is_paused?: boolean;
  digest_frequency?: DigestFrequency;
  created_at?: string;
  share_url?: string;
}

function authHeaders(): HeadersInit {
  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
  return token
    ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json' };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers: authHeaders() });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

/** Ownership-scoped saved-search management for the account settings view. */
export function useSavedSearches() {
  const [searches, setSearches] = useState<SavedSearch[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (typeof window === 'undefined' || !localStorage.getItem('token')) {
      setSearches([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      setSearches(await request<SavedSearch[]>(''));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load saved searches');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const mutate = useCallback(
    async (id: string, action: string, body?: Record<string, unknown>) => {
      setError(null);
      try {
        const updated = await request<SavedSearch>(`/${id}${action}`, {
          method: action === '' ? 'PUT' : 'PATCH',
          body: JSON.stringify(body ?? {}),
        });
        setSearches((current) => current.map((s) => (s.id === id ? updated : s)));
        return updated;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unable to update saved search');
        return null;
      }
    },
    [],
  );

  const create = useCallback(async (name: string, filters: Record<string, unknown>) => {
    setError(null);
    try {
      const created = await request<SavedSearch>('', {
        method: 'POST',
        body: JSON.stringify({ name, filters }),
      });
      setSearches((current) => [created, ...current]);
      return created;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save search');
      return null;
    }
  }, []);

  const remove = useCallback(async (id: string) => {
    setError(null);
    try {
      await request<void>(`/${id}`, { method: 'DELETE' });
      setSearches((current) => current.filter((s) => s.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to delete saved search');
    }
  }, []);

  const rename = useCallback((id: string, name: string) => mutate(id, '', { name }), [mutate]);
  const pause = useCallback((id: string) => mutate(id, '/pause'), [mutate]);
  const resume = useCallback((id: string) => mutate(id, '/resume'), [mutate]);
  const setFrequency = useCallback(
    (id: string, frequency: DigestFrequency) => mutate(id, '/frequency', { frequency }),
    [mutate],
  );

  return {
    searches,
    isLoading,
    error,
    refresh,
    create,
    rename,
    pause,
    resume,
    setFrequency,
    remove,
  };
}
