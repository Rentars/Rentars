'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

interface AdminProperty {
  id: string;
  title: string;
  status: string;
  moderation_state?: string;
  updated_at?: string;
  owner_id: string;
  price_per_night: number;
  created_at: string;
}

interface ConfirmAction {
  propertyId: string;
  action: 'suspend' | 'activate';
}

type BulkAction = 'approve' | 'reject';

interface BulkResultItem {
  id: string;
  success: boolean;
  error?: string;
}

interface BulkResponse {
  results?: BulkResultItem[];
}

const MODERATION_STATES = ['pending', 'approved', 'rejected'] as const;

export default function AdminPropertiesPage() {
  const [properties, setProperties] = useState<AdminProperty[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [moderationFilter, setModerationFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Record<string, string | undefined>>({});
  const [reason, setReason] = useState('');
  const [bulkLoading, setBulkLoading] = useState(false);
  const [bulkResults, setBulkResults] = useState<BulkResultItem[] | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);

  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;

  const fetchProperties = (status?: string, moderationState?: string, searchTerm?: string) => {
    setLoading(true);
    setError(null);
    const url = new URL(`${API_URL}/api/v1/admin/properties`);
    if (status && status !== 'all') url.searchParams.set('status', status);
    if (moderationState && moderationState !== 'all') {
      url.searchParams.set('moderation_state', moderationState);
    }
    if (searchTerm && searchTerm.trim()) url.searchParams.set('search', searchTerm.trim());
    fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((json) => {
        setProperties(json.data ?? []);
        setSelected({});
      })
      .catch(() => setError('Failed to load properties'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchProperties(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const applyFilters = () => {
    fetchProperties(statusFilter, moderationFilter, search);
  };

  const toggleSelected = (p: AdminProperty) => {
    setSelected((prev) => {
      const next = { ...prev };
      if (next[p.id]) {
        delete next[p.id];
      } else {
        next[p.id] = p.updated_at;
      }
      return next;
    });
  };

  const selectedIds = Object.keys(selected);
  const allSelected = properties.length > 0 && selectedIds.length === properties.length;

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelected({});
      return;
    }
    const next: Record<string, string | undefined> = {};
    properties.forEach((p) => { next[p.id] = p.updated_at; });
    setSelected(next);
  };

  const handleBulkAction = async (action: BulkAction) => {
    setBulkError(null);
    setBulkResults(null);
    if (selectedIds.length === 0) {
      setBulkError('Select at least one property.');
      return;
    }
    if (!reason.trim()) {
      setBulkError('A reason is required for moderation changes.');
      return;
    }
    setBulkLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/v1/admin/properties/bulk`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action,
          reason: reason.trim(),
          items: selectedIds.map((id) => ({ id, expected_updated_at: selected[id] })),
        }),
      });
      if (!res.ok) {
        setBulkError('Bulk action failed. Please retry.');
        return;
      }
      const json: BulkResponse = await res.json();
      setBulkResults(json.results ?? []);
      setReason('');
      fetchProperties(statusFilter, moderationFilter, search);
    } catch {
      setBulkError('Bulk action failed. Please retry.');
    } finally {
      setBulkLoading(false);
    }
  };

  const handleAction = async () => {
    if (!confirm) return;
    setActionLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/v1/admin/properties/${confirm.propertyId}/${confirm.action}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        setError('Action failed');
        return;
      }
      setConfirm(null);
      fetchProperties(statusFilter, moderationFilter, search);
    } catch {
      setError('Action failed');
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) return <p className="text-gray-500">Loading properties...</p>;
  if (error) return <p className="text-red-500">{error}</p>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Properties</h1>
        <div className="flex gap-2">
          {(['all', 'active', 'suspended'] as const).map((s) => (
            <Button
              key={s}
              variant={statusFilter === s ? 'default' : 'outline'}
              size="sm"
              onClick={() => {
                setStatusFilter(s);
                fetchProperties(s, moderationFilter, search);
              }}
            >
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </Button>
          ))}
        </div>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="moderation-filter" className="text-xs font-medium text-gray-500 uppercase">
              Moderation
            </label>
            <select
              id="moderation-filter"
              className="border border-gray-300 rounded-md px-2 py-1 text-sm"
              value={moderationFilter}
              onChange={(e) => setModerationFilter(e.target.value)}
            >
              <option value="all">All</option>
              {MODERATION_STATES.map((m) => (
                <option key={m} value={m}>{m.charAt(0).toUpperCase() + m.slice(1)}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1 flex-1 min-w-[200px]">
            <label htmlFor="search-filter" className="text-xs font-medium text-gray-500 uppercase">
              Search
            </label>
            <input
              id="search-filter"
              type="text"
              className="border border-gray-300 rounded-md px-2 py-1 text-sm"
              placeholder="Search by title or owner"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') applyFilters(); }}
            />
          </div>
          <Button size="sm" onClick={applyFilters}>Apply filters</Button>
        </div>

        <div className="flex flex-wrap items-end gap-3 border-t border-gray-100 pt-3">
          <div className="flex flex-col gap-1 flex-1 min-w-[240px]">
            <label htmlFor="bulk-reason" className="text-xs font-medium text-gray-500 uppercase">
              Reason (required)
            </label>
            <input
              id="bulk-reason"
              type="text"
              className="border border-gray-300 rounded-md px-2 py-1 text-sm"
              placeholder="Reason for moderation change"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <Button
            size="sm"
            onClick={() => handleBulkAction('approve')}
            disabled={bulkLoading || selectedIds.length === 0}
          >
            {bulkLoading ? 'Processing…' : `Approve selected (${selectedIds.length})`}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => handleBulkAction('reject')}
            disabled={bulkLoading || selectedIds.length === 0}
          >
            {bulkLoading ? 'Processing…' : `Reject selected (${selectedIds.length})`}
          </Button>
        </div>

        {bulkError && <p className="text-sm text-red-600">{bulkError}</p>}

        {bulkResults && (
          <div className="border-t border-gray-100 pt-3">
            <h2 className="text-sm font-semibold text-gray-900 mb-2">Bulk results</h2>
            <ul className="space-y-1 text-sm">
              {bulkResults.map((r) => (
                <li key={r.id} className={r.success ? 'text-green-700' : 'text-red-600'}>
                  {r.success ? 'Applied' : 'Not applied'} — {r.id}
                  {r.error ? `: ${r.error}` : ''}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                <input
                  type="checkbox"
                  aria-label="Select all properties"
                  checked={allSelected}
                  onChange={toggleSelectAll}
                />
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Title</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Moderation</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Price/night</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Created</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {properties.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-6 text-center text-gray-400">No properties found</td></tr>
            )}
            {properties.map((p) => (
              <tr key={p.id} className="hover:bg-gray-50">
                <td className="px-4 py-3">
                  <input
                    type="checkbox"
                    aria-label={`Select ${p.title}`}
                    checked={Boolean(selected[p.id])}
                    onChange={() => toggleSelected(p)}
                  />
                </td>
                <td className="px-4 py-3 font-medium text-gray-900">{p.title}</td>
                <td className="px-4 py-3">
                  <Badge variant={p.status === 'active' ? 'default' : 'destructive'}>{p.status}</Badge>
                </td>
                <td className="px-4 py-3 text-gray-600">{p.moderation_state ?? '—'}</td>
                <td className="px-4 py-3 text-gray-600">${Number(p.price_per_night).toFixed(2)}</td>
                <td className="px-4 py-3 text-gray-600">{new Date(p.created_at).toLocaleDateString()}</td>
                <td className="px-4 py-3 space-x-2">
                  {p.status !== 'suspended' ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-red-600 border-red-300 hover:bg-red-50"
                      onClick={() => setConfirm({ propertyId: p.id, action: 'suspend' })}
                    >
                      Suspend
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-green-600 border-green-300 hover:bg-green-50"
                      onClick={() => setConfirm({ propertyId: p.id, action: 'activate' })}
                    >
                      Activate
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {confirm && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-dialog-title"
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
        >
          <div className="bg-white rounded-lg p-6 max-w-sm w-full shadow-xl">
            <h2 id="confirm-dialog-title" className="text-lg font-semibold mb-2">
              Confirm {confirm.action}
            </h2>
            <p className="text-gray-600 mb-4">
              Are you sure you want to {confirm.action} this property?
            </p>
            <div className="flex gap-3 justify-end">
              <Button variant="outline" onClick={() => setConfirm(null)} disabled={actionLoading}>
                Cancel
              </Button>
              <Button
                variant={confirm.action === 'suspend' ? 'destructive' : 'default'}
                onClick={handleAction}
                disabled={actionLoading}
              >
                {actionLoading ? 'Processing…' : confirm.action === 'suspend' ? 'Suspend' : 'Activate'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
