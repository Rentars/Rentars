'use client';

import { useState } from 'react';
import {
  useSavedSearches,
  type DigestFrequency,
  type SavedSearch,
} from '@/hooks/useSavedSearches';

const FREQUENCIES: DigestFrequency[] = ['immediate', 'daily', 'weekly'];

function describeFilters(filters: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of ['query', 'city', 'country', 'min_price', 'max_price', 'bedrooms']) {
    const value = filters[key];
    if (value !== undefined && value !== null && value !== '') parts.push(`${key}: ${value}`);
  }
  const amenities = filters.amenities;
  if (Array.isArray(amenities) && amenities.length > 0) parts.push(`amenities: ${amenities.join(', ')}`);
  return parts.length > 0 ? parts.join(' · ') : 'All properties';
}

function SavedSearchCard({
  search,
  onRename,
  onFrequency,
  onTogglePause,
  onDelete,
}: {
  search: SavedSearch;
  onRename: (name: string) => void;
  onFrequency: (frequency: DigestFrequency) => void;
  onTogglePause: () => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(search.name);

  return (
    <li className="rounded-lg border border-gray-200 dark:border-gray-700 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <label className="sr-only" htmlFor={`name-${search.id}`}>
            Saved search name
          </label>
          <input
            id={`name-${search.id}`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() && name !== search.name && onRename(name.trim())}
            className="w-full rounded border px-2 py-1 font-semibold bg-transparent"
          />
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
            {describeFilters(search.filters ?? {})}
          </p>
          {search.is_paused && (
            <p className="mt-1 text-xs text-amber-600">Paused — no alerts are sent.</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <label className="sr-only" htmlFor={`frequency-${search.id}`}>
            Alert frequency for {search.name}
          </label>
          <select
            id={`frequency-${search.id}`}
            value={search.digest_frequency ?? 'immediate'}
            onChange={(e) => onFrequency(e.target.value as DigestFrequency)}
            className="rounded border bg-transparent px-2 py-1 text-sm"
          >
            {FREQUENCIES.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={onTogglePause}
            className="rounded border px-2 py-1 text-sm hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            {search.is_paused ? 'Resume' : 'Pause'}
          </button>
          <button
            type="button"
            onClick={onDelete}
            aria-label={`Delete ${search.name}`}
            className="rounded border px-2 py-1 text-sm text-red-600 hover:bg-red-50"
          >
            Delete
          </button>
        </div>
      </div>
      {search.share_url && (
        <a href={search.share_url} className="mt-2 inline-block text-sm text-blue-600 underline">
          Reopen search
        </a>
      )}
    </li>
  );
}

export default function SavedSearchesPage() {
  const {
    searches,
    isLoading,
    error,
    create,
    rename,
    pause,
    resume,
    setFrequency,
    remove,
  } = useSavedSearches();
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [city, setCity] = useState('');

  const signedIn = typeof window === 'undefined' || !!window.localStorage.getItem('token');

  return (
    <div className="max-w-3xl mx-auto">
      <h1 className="text-2xl font-bold mb-2">Saved searches &amp; alerts</h1>
      <p className="text-sm text-gray-600 dark:text-gray-300 mb-6">
        Manage the searches that generate listing alerts. Only your own saved searches are shown.
      </p>

      {error && (
        <p role="alert" className="mb-4 rounded bg-red-50 p-3 text-sm text-red-700">
          {error}
        </p>
      )}

      {!signedIn && (
        <p className="mb-4 rounded bg-amber-50 p-3 text-sm">
          Sign in to create and manage saved searches.
        </p>
      )}

      <form
        className="mb-8 space-y-3 rounded-lg border p-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          const filters: Record<string, unknown> = {};
          if (query.trim()) filters.query = query.trim();
          if (city.trim()) filters.city = city.trim();
          if (await create(name.trim(), filters)) {
            setName('');
            setQuery('');
            setCity('');
          }
        }}
      >
        <h2 className="font-semibold">New saved search</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <label>
            <span className="block text-sm">Name</span>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded border px-2 py-1"
            />
          </label>
          <label>
            <span className="block text-sm">Keyword</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="mt-1 w-full rounded border px-2 py-1"
            />
          </label>
          <label>
            <span className="block text-sm">City</span>
            <input
              value={city}
              onChange={(e) => setCity(e.target.value)}
              className="mt-1 w-full rounded border px-2 py-1"
            />
          </label>
        </div>
        <button
          type="submit"
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          Save search
        </button>
      </form>

      {isLoading ? (
        <p role="status">Loading saved searches…</p>
      ) : searches.length === 0 ? (
        <p>No saved searches yet.</p>
      ) : (
        <ul className="space-y-3">
          {searches.map((search) => (
            <SavedSearchCard
              key={search.id}
              search={search}
              onRename={(newName) => void rename(search.id, newName)}
              onFrequency={(frequency) => void setFrequency(search.id, frequency)}
              onTogglePause={() =>
                void (search.is_paused ? resume(search.id) : pause(search.id))
              }
              onDelete={() => void remove(search.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
