'use client';

import { Fragment, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

interface DisputeEvent {
  id: string;
  from_status: string | null;
  to_status: string;
  reason: string | null;
  actor_id: string | null;
  created_at: string;
}

interface DisputeEvidence {
  id: string;
  uploaded_by: string;
  description: string | null;
  url: string;
  created_at: string;
}

interface Dispute {
  id: string;
  property_id: string;
  user_id: string;
  status: string;
  check_in: string;
  check_out: string;
  total_price: number;
  created_at: string;
  assigned_admin_id?: string | null;
  decision?: string | null;
  decision_reason?: string | null;
  decided_by?: string | null;
  decided_at?: string | null;
  settlement_status?: string | null;
  settlement_reference?: string | null;
  settlement_error?: string | null;
  timeline?: DisputeEvent[];
  evidence?: DisputeEvidence[];
}

interface ResolveModal {
  disputeId: string;
}

const SETTLEMENT_LABELS: Record<string, string> = {
  pending: 'Settlement pending',
  processing: 'Settlement processing',
  completed: 'Settlement completed',
  failed: 'Settlement failed',
  not_required: 'No payment action',
};

export default function AdminDisputesPage() {
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resolveModal, setResolveModal] = useState<ResolveModal | null>(null);
  const [resolutionNote, setResolutionNote] = useState('');
  const [outcome, setOutcome] = useState<'refund_tenant' | 'release_to_host' | 'split'>('release_to_host');
  const [paymentConsequence, setPaymentConsequence] = useState<'refund' | 'release' | 'split' | 'none'>('none');
  const [actionLoading, setActionLoading] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);

  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;

  const fetchDisputes = () => {
    setLoading(true);
    fetch(`${API_URL}/api/v1/admin/disputes`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((json) => setDisputes(json.data ?? []))
      .catch(() => setError('Failed to load disputes'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchDisputes(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleResolve = async () => {
    if (!resolveModal || !resolutionNote.trim()) return;
    setActionLoading(true);
    try {
      const response = await fetch(
        `${API_URL}/api/v1/admin/disputes/${resolveModal.disputeId}/resolve`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            resolution_note: resolutionNote,
            outcome,
            payment_consequence: paymentConsequence,
          }),
        },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error?.message || 'Failed to resolve');
      }
      setResolveModal(null);
      setResolutionNote('');
      setPaymentConsequence('none');
      fetchDisputes();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resolve dispute');
    } finally {
      setActionLoading(false);
    }
  };

  const toggleExpanded = (id: string) => {
    setEvidenceError(null);
    setExpandedId((current) => (current === id ? null : id));
  };

  if (loading) return <p className="text-gray-500">Loading disputes...</p>;
  if (error) return <p className="text-red-500">{error}</p>;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Disputes</h1>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Booking</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Check-in</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Total</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {disputes.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-400">No open disputes</td></tr>
            )}
            {disputes.map((d) => (
              <Fragment key={d.id}>
                <tr className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-mono text-xs text-gray-600">{d.id.slice(0, 8)}…</td>
                  <td className="px-4 py-3">
                    <Badge variant="destructive">{d.status}</Badge>
                    {d.assigned_admin_id && (
                      <p className="mt-1 text-xs text-gray-500">
                        Reviewer: <span className="font-mono">{d.assigned_admin_id.slice(0, 8)}…</span>
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{new Date(d.check_in).toLocaleDateString()}</td>
                  <td className="px-4 py-3 text-gray-900 font-medium">${Number(d.total_price).toFixed(2)}</td>
                  <td className="px-4 py-3 space-y-1">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setResolveModal({ disputeId: d.id })}
                    >
                      Resolve
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => toggleExpanded(d.id)}>
                      {expandedId === d.id ? 'Hide details' : 'View details'}
                    </Button>
                  </td>
                </tr>
                {expandedId === d.id && (
                  <tr className="bg-gray-50">
                    <td colSpan={5} className="px-4 py-4 space-y-4">
                      <div>
                        <h3 className="text-xs font-semibold uppercase text-gray-500 mb-1">Decision</h3>
                        {d.decision ? (
                          <div className="text-sm text-gray-700 space-y-1">
                            <p>
                              <span className="font-medium">Outcome:</span> {d.decision}
                            </p>
                            <p>
                              <span className="font-medium">Reasoning:</span> {d.decision_reason || '—'}
                            </p>
                            <p className="text-xs text-gray-500">
                              Decided by <span className="font-mono">{d.decided_by?.slice(0, 8) ?? '—'}…</span>
                              {d.decided_at ? ` on ${new Date(d.decided_at).toLocaleString()}` : ''}
                            </p>
                          </div>
                        ) : (
                          <p className="text-sm text-gray-400">No decision recorded yet.</p>
                        )}
                      </div>

                      <div>
                        <h3 className="text-xs font-semibold uppercase text-gray-500 mb-1">
                          Payment consequence
                        </h3>
                        <p className="text-sm text-gray-700">
                          {SETTLEMENT_LABELS[d.settlement_status ?? 'not_required'] ??
                            d.settlement_status}
                        </p>
                        {d.settlement_reference && (
                          <p className="text-xs text-gray-500 font-mono">
                            Ref: {d.settlement_reference}
                          </p>
                        )}
                        {d.settlement_error && (
                          <p className="text-xs text-red-600">Error: {d.settlement_error}</p>
                        )}
                        <p className="text-xs text-gray-400 mt-1">
                          A decision is not a financial settlement until the payment step is
                          verified as completed.
                        </p>
                      </div>

                      <div>
                        <h3 className="text-xs font-semibold uppercase text-gray-500 mb-1">
                          Status timeline
                        </h3>
                        {d.timeline && d.timeline.length > 0 ? (
                          <ol className="space-y-2">
                            {d.timeline.map((event) => (
                              <li key={event.id} className="text-sm text-gray-700">
                                <span className="font-medium">
                                  {event.from_status ?? 'created'} → {event.to_status}
                                </span>
                                <span className="ml-2 text-xs text-gray-500">
                                  {new Date(event.created_at).toLocaleString()}
                                </span>
                                {event.reason && (
                                  <p className="text-xs text-gray-500">{event.reason}</p>
                                )}
                              </li>
                            ))}
                          </ol>
                        ) : (
                          <p className="text-sm text-gray-400">No status transitions recorded.</p>
                        )}
                      </div>

                      <div>
                        <h3 className="text-xs font-semibold uppercase text-gray-500 mb-1">
                          Evidence (authorized administrators only)
                        </h3>
                        {evidenceError && <p className="text-xs text-red-600">{evidenceError}</p>}
                        {d.evidence && d.evidence.length > 0 ? (
                          <ul className="space-y-1">
                            {d.evidence.map((item) => (
                              <li key={item.id} className="text-sm text-gray-700">
                                <a
                                  href={item.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-blue-600 hover:underline"
                                >
                                  {item.description || item.url}
                                </a>
                                <span className="ml-2 text-xs text-gray-500">
                                  {new Date(item.created_at).toLocaleDateString()}
                                </span>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="text-sm text-gray-400">No evidence attached.</p>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {resolveModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="resolve-dialog-title"
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
        >
          <div className="bg-white rounded-lg p-6 max-w-md w-full shadow-xl space-y-4">
            <h2 id="resolve-dialog-title" className="text-lg font-semibold">Resolve Dispute</h2>

            <div>
              <label htmlFor="outcome" className="block text-sm font-medium text-gray-700 mb-1">
                Outcome
              </label>
              <select
                id="outcome"
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                value={outcome}
                onChange={(e) => setOutcome(e.target.value as typeof outcome)}
              >
                <option value="release_to_host">Release to host</option>
                <option value="refund_tenant">Refund tenant</option>
                <option value="split">Split</option>
              </select>
            </div>

            <div>
              <label htmlFor="payment-consequence" className="block text-sm font-medium text-gray-700 mb-1">
                Payment consequence
              </label>
              <select
                id="payment-consequence"
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                value={paymentConsequence}
                onChange={(e) => setPaymentConsequence(e.target.value as typeof paymentConsequence)}
              >
                <option value="none">No payment action</option>
                <option value="refund">Refund tenant</option>
                <option value="release">Release to host</option>
                <option value="split">Split</option>
              </select>
              <p className="mt-1 text-xs text-gray-500">
                The decision is recorded first; settlement is processed and verified separately.
              </p>
            </div>

            <div>
              <label htmlFor="resolution-note" className="block text-sm font-medium text-gray-700 mb-1">
                Decision Reasoning <span className="text-red-500">*</span>
              </label>
              <textarea
                id="resolution-note"
                rows={4}
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm resize-none"
                placeholder="Explain the resolution decision..."
                value={resolutionNote}
                onChange={(e) => setResolutionNote(e.target.value)}
              />
            </div>

            <div className="flex gap-3 justify-end">
              <Button variant="outline" onClick={() => setResolveModal(null)} disabled={actionLoading}>
                Cancel
              </Button>
              <Button
                onClick={handleResolve}
                disabled={actionLoading || !resolutionNote.trim()}
              >
                {actionLoading ? 'Resolving…' : 'Resolve Dispute'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
