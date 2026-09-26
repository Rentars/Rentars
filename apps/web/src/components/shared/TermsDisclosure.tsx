'use client';

/**
 * TermsDisclosure
 *
 * Shows the current platform policy (fees, refund tiers, escrow behaviour,
 * blockchain risks) and requires the user to check a box before proceeding.
 *
 * Usage:
 *   - In booking flow: show before the final "Confirm booking" button.
 *   - In listing flow: show before the "Publish listing" button.
 *   - In payment/cancellation: show inline when relevant.
 *
 * Acceptance is recorded with a timestamp and the policy version string so
 * both can be submitted to the API alongside the action.
 */

import { useState, useEffect } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, ExternalLink, ShieldCheck } from 'lucide-react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

// ── Types mirroring the backend PolicySnapshot ────────────────────────────────

interface RefundTier {
  id: string;
  label: string;
  refundPct: number;
  description: string;
}

interface EscrowPolicy {
  provider: string;
  currency: string;
  network: string;
  holdDescription: string;
  disputeHoldDescription: string;
}

export interface PolicySnapshot {
  version: string;
  effectiveDate: string;
  platformFeePct: number;
  refundTiers: RefundTier[];
  escrow: EscrowPolicy;
  blockchainRisks: string[];
  termsUrl: string;
  privacyUrl: string;
}

export interface TermsAcceptance {
  termsVersion: string;
  termsAcceptedAt: string; // ISO timestamp
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SectionHeader({
  title,
  expanded,
  onToggle,
}: {
  title: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex items-center justify-between w-full text-left text-sm font-semibold
        text-gray-800 dark:text-gray-200 py-2 hover:text-gray-600 dark:hover:text-gray-400
        transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
      aria-expanded={expanded}
    >
      {title}
      {expanded ? <ChevronUp size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}
    </button>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface TermsDisclosureProps {
  /** Called when the user checks/unchecks acceptance. Receives null when unchecked. */
  onAcceptanceChange: (acceptance: TermsAcceptance | null) => void;
  /** Whether the checkbox is in its accepted state (controlled). */
  accepted: boolean;
  /** Visual variant: 'booking' | 'listing' | 'cancellation' */
  variant?: 'booking' | 'listing' | 'cancellation';
  /** Pre-loaded policy (optional — component fetches it if not provided). */
  policy?: PolicySnapshot;
}

export function TermsDisclosure({
  onAcceptanceChange,
  accepted,
  variant = 'booking',
  policy: externalPolicy,
}: TermsDisclosureProps) {
  const [policy, setPolicy] = useState<PolicySnapshot | null>(externalPolicy ?? null);
  const [loading, setLoading] = useState(!externalPolicy);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const [showFees, setShowFees] = useState(false);
  const [showRefunds, setShowRefunds] = useState(true);
  const [showEscrow, setShowEscrow] = useState(false);
  const [showRisks, setShowRisks] = useState(false);

  useEffect(() => {
    if (externalPolicy) return;
    let cancelled = false;
    setLoading(true);
    fetch(`${API_URL}/api/v1/policy/current`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: PolicySnapshot) => {
        if (!cancelled) setPolicy(data);
      })
      .catch(() => {
        if (!cancelled) setFetchError('Could not load platform policy. Please refresh and try again.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [externalPolicy]);

  const handleCheckboxChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.checked && policy) {
      onAcceptanceChange({
        termsVersion: policy.version,
        termsAcceptedAt: new Date().toISOString(),
      });
    } else {
      onAcceptanceChange(null);
    }
  };

  if (loading) {
    return (
      <div className="animate-pulse rounded-xl border border-gray-200 dark:border-gray-700 p-5 space-y-2">
        <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-1/2" />
        <div className="h-3 bg-gray-200 dark:bg-gray-700 rounded w-3/4" />
        <div className="h-3 bg-gray-200 dark:bg-gray-700 rounded w-2/3" />
      </div>
    );
  }

  if (fetchError || !policy) {
    return (
      <div role="alert" className="flex items-start gap-3 p-4 rounded-xl border border-red-200
        dark:border-red-800 bg-red-50 dark:bg-red-950 text-red-700 dark:text-red-300 text-sm">
        <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
        {fetchError ?? 'Platform policy unavailable.'}
      </div>
    );
  }

  const platformFeePct = Math.round(policy.platformFeePct * 100);

  const variantLabel =
    variant === 'listing'
      ? 'listing your property'
      : variant === 'cancellation'
        ? 'cancelling this booking'
        : 'booking';

  return (
    <section
      aria-label="Platform terms and disclosures"
      className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900
        shadow-sm overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-5 py-4 border-b border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-950">
        <ShieldCheck size={18} className="text-blue-600 dark:text-blue-400 flex-shrink-0" aria-hidden="true" />
        <div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
            Terms &amp; Disclosures
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            Review before {variantLabel} · Policy version {policy.version}
          </p>
        </div>
      </div>

      <div className="px-5 py-4 space-y-3">

        {/* ── Fees ──────────────────────────────────────────────────────── */}
        {variant !== 'cancellation' && (
          <div className="border-b border-gray-100 dark:border-gray-800 pb-3">
            <SectionHeader title={`Platform fee: ${platformFeePct}%`} expanded={showFees} onToggle={() => setShowFees((v) => !v)} />
            {showFees && (
              <div className="text-sm text-gray-600 dark:text-gray-400 space-y-1 pt-1">
                <p>
                  A <strong>{platformFeePct}%</strong> platform fee is added to the nightly rate
                  and charged to the tenant at checkout. This fee is non-refundable except on full-refund
                  cancellations made at least 7 days before check-in.
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-500">
                  Stellar network transaction fees (~0.000001–0.001 XLM) are separate and paid by
                  your Freighter wallet. Rentars does not control these fees.
                </p>
              </div>
            )}
          </div>
        )}

        {/* ── Refund policy ──────────────────────────────────────────────── */}
        <div className="border-b border-gray-100 dark:border-gray-800 pb-3">
          <SectionHeader title="Cancellation &amp; refund policy" expanded={showRefunds} onToggle={() => setShowRefunds((v) => !v)} />
          {showRefunds && (
            <ul className="mt-2 space-y-2" aria-label="Refund tiers">
              {policy.refundTiers.map((tier) => (
                <li key={tier.id} className="flex items-start gap-2 text-sm text-gray-600 dark:text-gray-400">
                  <span
                    className={`mt-1 flex-shrink-0 w-2 h-2 rounded-full ${
                      tier.id === 'full'
                        ? 'bg-green-500'
                        : tier.id === 'partial'
                          ? 'bg-amber-500'
                          : 'bg-red-500'
                    }`}
                    aria-hidden="true"
                  />
                  <span>
                    <span className="font-medium">{tier.label}</span> — {tier.description}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* ── Escrow ────────────────────────────────────────────────────── */}
        <div className="border-b border-gray-100 dark:border-gray-800 pb-3">
          <SectionHeader title="Escrow &amp; payment settlement" expanded={showEscrow} onToggle={() => setShowEscrow((v) => !v)} />
          {showEscrow && (
            <div className="mt-2 space-y-2 text-sm text-gray-600 dark:text-gray-400">
              <p>{policy.escrow.holdDescription}</p>
              <p className="text-xs text-gray-500 dark:text-gray-500">{policy.escrow.disputeHoldDescription}</p>
              <p className="text-xs text-gray-500 dark:text-gray-500">
                Escrow provider: {policy.escrow.provider} · Currency: {policy.escrow.currency} · Network: {policy.escrow.network}
              </p>
            </div>
          )}
        </div>

        {/* ── Blockchain risks ───────────────────────────────────────────── */}
        <div className="border-b border-gray-100 dark:border-gray-800 pb-3">
          <SectionHeader title="Blockchain &amp; network risks" expanded={showRisks} onToggle={() => setShowRisks((v) => !v)} />
          {showRisks && (
            <ul className="mt-2 space-y-1.5" aria-label="Blockchain risks">
              {policy.blockchainRisks.map((risk, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-gray-600 dark:text-gray-400">
                  <AlertTriangle size={13} className="flex-shrink-0 mt-0.5 text-amber-500" aria-hidden="true" />
                  {risk}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* ── Links ────────────────────────────────────────────────────── */}
        <div className="flex gap-4 text-xs text-blue-600 dark:text-blue-400 pt-1">
          <a
            href={policy.termsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
          >
            Full Terms of Service <ExternalLink size={11} aria-hidden="true" />
          </a>
          <a
            href={policy.privacyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
          >
            Privacy Policy <ExternalLink size={11} aria-hidden="true" />
          </a>
        </div>

        {/* ── Acceptance checkbox ───────────────────────────────────────── */}
        <label className="flex items-start gap-3 cursor-pointer group pt-2">
          <input
            type="checkbox"
            checked={accepted}
            onChange={handleCheckboxChange}
            className="mt-0.5 h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-blue-600
              focus:ring-blue-500 focus:ring-2 cursor-pointer"
            aria-required="true"
          />
          <span className="text-sm text-gray-700 dark:text-gray-300 group-hover:text-gray-900 dark:group-hover:text-gray-100 transition-colors">
            I have read and agree to the platform fees, refund policy, escrow terms, and
            blockchain risks described above. I understand this acceptance is recorded with
            policy version <code className="font-mono text-xs bg-gray-100 dark:bg-gray-800 px-1 py-0.5 rounded">{policy.version}</code> and
            cannot be changed after booking.
          </span>
        </label>

      </div>
    </section>
  );
}
