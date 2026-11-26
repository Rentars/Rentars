'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

type SettlementState = 'none' | 'pending' | 'completed' | 'failed';

interface DisputeTimelineEvent {
  type: string;
  occurred_at: string;
  settlement_state?: SettlementState | null;
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
  decision_recorded?: boolean;
  decision_recorded_at?: string | null;
  settlement_state?: SettlementState;
  settlement_completed_at?: string | null;
  settlement_failed_reason?: string | null;
  timeline?: DisputeTimelineEvent[];
}

interface ResolveModal {
  disputeId: string;
}

const SETTLEMENT_LABELS: Record<SettlementState, string> = {
  none: 'No financial action',
  pending: 'Settlement pending',
  completed: 'Settlement completed',
  failed: 'Settlement failed',
};

function settlementVariant(state: SettlementState): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (state) {
    case 'completed':
      return 'default';
    case 'pending':
      return 'secondary';
    case 'failed':
      return 'destructive';
    default:
      return 'outline';
  }
}

function decisionState(d: Dispute): { recorded: boolean; label: string } {
  const recorded = d.decision_recorded ?? d.status === 'resolved';
  return {
    recorded,
    label: recorded ? 'Decision recorded' : 'No decision yet',
  };
}

function settlementState(d: Dispute): SettlementState {
  if (d.settlement_state) return d.settlement_state;
  // Fall back conservatively: a resolved dispute without verified settlement
  // data must not be presented as fully settled.
  return d.status === 'resolved' ? 'pending' : 'none';
}

export default function AdminDisputesPage() {
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resolveModal, setResolveModal] = useState<ResolveModal | null>(null);
  const [resolutionNote, setResolutionNote] = useState('');
  const [outcome, setOutcome] = useState<'refund_tenant' | 'release_to_host' | 'split'>('release_to_host');
  const [actionLoading, setActionLoading] = useState(false);

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
          body: JSON.stringify({ resolution_note: resolutionNote, outcome }),
        },
      );
      if (!response.ok) throw new Error('Failed to resolve');
      setResolveModal(null);
      setResolutionNote('');
      fetchDisputes();
    } catch {
      setError('Failed to resolve dispute');
    } finally {
      setActionLoading(false);
    }
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
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Decision</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Settlement</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Check-in</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Total</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {disputes.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-6 text-center text-gray-400">No open disputes</td></tr>
            )}
            {disputes.map((d) => {
              const decision = decisionState(d);
              const settlement = settlementState(d);
              return (
                <tr key={d.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-mono text-xs text-gray-600">{d.id.slice(0, 8)}…</td>
                  <td className="px-4 py-3">
                    <Badge variant="destructive">{d.status}</Badge>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={decision.recorded ? 'default' : 'outline'}>
                      {decision.label}
                    </Badge>
                    {decision.recorded && d.decision_recorded_at && (
                      <p className="mt-1 text-xs text-gray-500">
                        {new Date(d.decision_recorded_at).toLocaleString()}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={settlementVariant(settlement)}>
                      {SETTLEMENT_LABELS[settlement]}
                    </Badge>
                    {settlement === 'completed' && d.settlement_completed_at && (
                      <p className="mt-1 text-xs text-gray-500">
                        {new Date(d.settlement_completed_at).toLocaleString()}
                      </p>
                    )}
                    {settlement === 'failed' && d.settlement_failed_reason && (
                      <p className="mt-1 text-xs text-red-600">{d.settlement_failed_reason}</p>
                    )}
                    {decision.recorded && settlement !== 'completed' && (
                      <p className="mt-1 text-xs text-amber-600">
                        Decision recorded — settlement not yet verified
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{new Date(d.check_in).toLocaleDateString()}</td>
                  <td className="px-4 py-3 text-gray-900 font-medium">${Number(d.total_price).toFixed(2)}</td>
                  <td className="px-4 py-3">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setResolveModal({ disputeId: d.id })}
                    >
                      Resolve
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {disputes.some((d) => decisionState(d).recorded && settlementState(d) !== 'completed') && (
        <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-4 py-3">
          Some disputes have a recorded decision whose financial settlement is still pending or failed.
          These are not fully resolved until the refund or release is verified.
        </p>
      )}

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
              <label htmlFor="resolution-note" className="block text-sm font-medium text-gray-700 mb-1">
                Resolution Note <span className="text-red-500">*</span>
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
