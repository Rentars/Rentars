'use client';

/**
 * Booking page — Issue 651
 *
 * Mobile-first wizard flow:
 *   Step 1  Rules     – House rules acknowledgement (skipped when no rules)
 *   Step 2  Terms     – Terms & disclosures acceptance
 *   Step 3  Details   – Date / guest picker (BookingForm)
 *   Step 4  Wallet    – Wallet connection (shown inline; modal on tap)
 *   Step 5  Confirm   – Final review + submit
 *
 * State is persisted to sessionStorage so wallet hand-offs (Freighter opens
 * an external tab then returns) restore the user to the correct step with
 * all form data intact.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { CheckCircle2, AlertCircle, ChevronRight, Wallet, Loader2 } from 'lucide-react';
import BookingForm from '@/components/booking/BookingForm';
import WalletConnectionModal from '@/components/booking/WalletConnectionModal';
import HouseRulesAcknowledgement, {
  type HouseRules,
} from '@/components/booking/HouseRulesAcknowledgement';
import { TermsDisclosure, type TermsAcceptance } from '@/components/shared/TermsDisclosure';
import { isValidStellarAddress } from '@/lib/freighter-utils';
import { useTranslations } from '@/lib/i18n/useTranslations';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

// ─── Session-storage helpers ──────────────────────────────────────────────────
// Keys are scoped per-property so multiple properties don't bleed state.

function ssKey(propertyId: string, field: string) {
  return `rntr_booking_${propertyId}_${field}`;
}

function ssGet<T>(key: string): T | null {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function ssSet(key: string, value: unknown) {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota exceeded — continue silently
  }
}

function ssClear(propertyId: string) {
  if (typeof sessionStorage === 'undefined') return;
  ['step', 'rulesTs', 'terms', 'formData'].forEach((f) =>
    sessionStorage.removeItem(ssKey(propertyId, f)),
  );
}

// ─── Step definitions ─────────────────────────────────────────────────────────

type Step = 'rules' | 'terms' | 'details' | 'wallet' | 'confirm';

interface StepConfig {
  id: Step;
  label: string;
  /** Step is included in the wizard only when this returns true */
  when: (ctx: StepContext) => boolean;
}

interface StepContext {
  hasRules: boolean;
}

const STEPS: StepConfig[] = [
  { id: 'rules',   label: 'House Rules', when: ({ hasRules }) => hasRules },
  { id: 'terms',   label: 'Terms',       when: () => true },
  { id: 'details', label: 'Stay Details',when: () => true },
  { id: 'wallet',  label: 'Wallet',      when: () => true },
  { id: 'confirm', label: 'Confirm',     when: () => true },
];

function activeSteps(ctx: StepContext): StepConfig[] {
  return STEPS.filter((s) => s.when(ctx));
}

// ─── Persisted form data shape ────────────────────────────────────────────────

interface PersistedFormData {
  checkIn:    string; // ISO date string
  checkOut:   string;
  guestCount: number;
  totalPrice: number;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function BookingPage() {
  const router       = useRouter();
  const searchParams = useSearchParams();
  const propertyId   = searchParams.get('propertyId') || 'property-id';

  const t = useTranslations('booking');

  // ── Wallet state ────────────────────────────────────────────────────────────
  const [walletAddress, setWalletAddress]     = useState<string | null>(null);
  const [walletConnected, setWalletConnected] = useState(false);
  const [showWalletModal, setShowWalletModal] = useState(false);

  // ── House rules ─────────────────────────────────────────────────────────────
  const [houseRules, setHouseRules]               = useState<HouseRules | null>(null);
  const [rulesAcknowledgedAt, setRulesAcknowledgedAt] = useState('');

  // ── Terms ───────────────────────────────────────────────────────────────────
  const [termsAcceptance, setTermsAcceptance] = useState<TermsAcceptance | null>(null);

  // ── Booking form data ───────────────────────────────────────────────────────
  const [formData, setFormData] = useState<PersistedFormData | null>(null);

  // ── UI ──────────────────────────────────────────────────────────────────────
  const [step, setStep]         = useState<Step>('terms');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError]   = useState('');

  // Focus the step heading when the step changes so screen readers announce it
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);

  // ── Restore state from sessionStorage on mount ──────────────────────────────
  useEffect(() => {
    // Wallet
    const saved = localStorage.getItem('walletAddress');
    if (saved && isValidStellarAddress(saved)) {
      setWalletAddress(saved);
      setWalletConnected(true);
    }

    // Persisted form data (survives wallet hand-off)
    const savedForm = ssGet<PersistedFormData>(ssKey(propertyId, 'formData'));
    if (savedForm) setFormData(savedForm);

    const savedRulesTs = ssGet<string>(ssKey(propertyId, 'rulesTs'));
    if (savedRulesTs) setRulesAcknowledgedAt(savedRulesTs);

    const savedTerms = ssGet<TermsAcceptance>(ssKey(propertyId, 'terms'));
    if (savedTerms) setTermsAcceptance(savedTerms);

    // Restore step — validated against available steps after rules load
    const savedStep = ssGet<Step>(ssKey(propertyId, 'step'));
    if (savedStep) setStep(savedStep);
  }, [propertyId]);

  // ── Fetch house rules ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!propertyId || propertyId === 'property-id') return;
    const token = localStorage.getItem('token');
    fetch(`${API_URL}/api/v1/properties/${propertyId}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        const rules: HouseRules = {
          pets_allowed:     data.pets_allowed,
          smoking_allowed:  data.smoking_allowed,
          events_allowed:   data.events_allowed,
          quiet_hours_start: data.quiet_hours_start,
          quiet_hours_end:   data.quiet_hours_end,
          additional_rules:  data.additional_rules,
        };
        setHouseRules(rules);
      })
      .catch(() => {});
  }, [propertyId]);

  // Focus step heading on transition
  useEffect(() => {
    stepHeadingRef.current?.focus();
  }, [step]);

  // ── Derived context & steps ─────────────────────────────────────────────────
  const hasRules =
    houseRules !== null &&
    (houseRules.pets_allowed !== undefined ||
      houseRules.smoking_allowed !== undefined ||
      houseRules.events_allowed !== undefined ||
      houseRules.quiet_hours_start ||
      houseRules.additional_rules);

  const ctx: StepContext = { hasRules: !!hasRules };
  const steps = activeSteps(ctx);
  const stepIndex = steps.findIndex((s) => s.id === step);
  // Guard: if persisted step is not in active steps, default to first
  const safeStep = stepIndex === -1 ? steps[0] : steps[stepIndex];

  const advance = useCallback(
    (nextStep?: Step) => {
      const idx = steps.findIndex((s) => s.id === (nextStep ?? step));
      const next = steps[idx + 1];
      if (next) {
        setStep(next.id);
        ssSet(ssKey(propertyId, 'step'), next.id);
      }
    },
    [steps, step, propertyId],
  );

  const goBack = useCallback(() => {
    const idx = steps.findIndex((s) => s.id === step);
    if (idx > 0) {
      const prev = steps[idx - 1];
      setStep(prev.id);
      ssSet(ssKey(propertyId, 'step'), prev.id);
    }
  }, [steps, step, propertyId]);

  // ── Step handlers ───────────────────────────────────────────────────────────

  const handleRulesAcknowledge = (ts: string) => {
    setRulesAcknowledgedAt(ts);
    ssSet(ssKey(propertyId, 'rulesTs'), ts);
    advance('rules');
  };

  const handleTermsAccepted = (acceptance: TermsAcceptance) => {
    setTermsAcceptance(acceptance);
    ssSet(ssKey(propertyId, 'terms'), acceptance);
    advance('terms');
  };

  const handleFormSubmit = (data: {
    checkIn: Date; checkOut: Date; guestCount: number; totalPrice: number;
  }) => {
    const persisted: PersistedFormData = {
      checkIn:    data.checkIn.toISOString(),
      checkOut:   data.checkOut.toISOString(),
      guestCount: data.guestCount,
      totalPrice: data.totalPrice,
    };
    setFormData(persisted);
    ssSet(ssKey(propertyId, 'formData'), persisted);

    if (!walletConnected) {
      // Wallet step next — open modal immediately on mobile
      setShowWalletModal(true);
      advance('details');
    } else {
      advance('details');
    }
  };

  const handleWalletConnect = (address: string) => {
    setWalletAddress(address);
    setWalletConnected(true);
    setShowWalletModal(false);
    // Wallet return may bring us back mid-flow — go to confirm if we have form data
    if (formData) {
      setStep('confirm');
      ssSet(ssKey(propertyId, 'step'), 'confirm');
    } else {
      advance('wallet');
    }
  };

  const handleWalletDisconnect = () => {
    localStorage.removeItem('walletAddress');
    setWalletAddress(null);
    setWalletConnected(false);
  };

  // ── Final booking submission ─────────────────────────────────────────────────
  const handleConfirm = async () => {
    if (!formData || !walletConnected || !walletAddress || !termsAcceptance) return;
    setIsSubmitting(true);
    setSubmitError('');

    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`${API_URL}/api/bookings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          property_id:          propertyId,
          check_in:             formData.checkIn,
          check_out:            formData.checkOut,
          guest_count:          formData.guestCount,
          total_price:          formData.totalPrice,
          wallet_address:       walletAddress,
          rules_acknowledged_at: rulesAcknowledgedAt || new Date().toISOString(),
          terms_version:        termsAcceptance.termsVersion,
          terms_accepted_at:    termsAcceptance.termsAcceptedAt,
        }),
      });

      if (response.ok) {
        const booking = await response.json();
        ssClear(propertyId);
        router.push(`/booking/confirmation/${booking.id}`);
      } else {
        const body = await response.json().catch(() => ({}));
        setSubmitError(body?.error?.message ?? t('failed'));
      }
    } catch {
      setSubmitError(t('error'));
    } finally {
      setIsSubmitting(false);
    }
  };

  // ─── Progress indicator ─────────────────────────────────────────────────────
  const currentStepIndex = steps.findIndex((s) => s.id === (safeStep?.id ?? step));

  return (
    <main className="min-h-screen bg-gray-50 dark:bg-gray-950">
      {/* ── Top bar with progress ──────────────────────────────────────── */}
      <div className="sticky top-0 z-20 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 px-4 py-3 sm:px-6">
        <div className="max-w-2xl mx-auto">
          {/* Back button */}
          <div className="flex items-center gap-3 mb-2">
            {currentStepIndex > 0 && (
              <button
                type="button"
                onClick={goBack}
                className="text-sm text-gray-500 hover:text-gray-900 dark:hover:text-white
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
              >
                ← Back
              </button>
            )}
            <span className="text-sm font-medium text-gray-900 dark:text-white">
              {t('title')}
            </span>
            <span className="ml-auto text-xs text-gray-400">
              Step {currentStepIndex + 1} of {steps.length}
            </span>
          </div>

          {/* Step progress bar */}
          <div
            role="progressbar"
            aria-valuenow={currentStepIndex + 1}
            aria-valuemin={1}
            aria-valuemax={steps.length}
            aria-label={`Booking step ${currentStepIndex + 1} of ${steps.length}: ${steps[currentStepIndex]?.label}`}
            className="h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden"
          >
            <div
              className="h-full bg-blue-600 rounded-full transition-all duration-300"
              style={{ width: `${((currentStepIndex + 1) / steps.length) * 100}%` }}
            />
          </div>

          {/* Step pills (desktop only) */}
          <div className="hidden sm:flex items-center gap-1 mt-2" aria-hidden="true">
            {steps.map((s, i) => (
              <div key={s.id} className="flex items-center gap-1">
                <span
                  className={`text-xs px-2 py-0.5 rounded-full font-medium transition ${
                    i < currentStepIndex
                      ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
                      : i === currentStepIndex
                      ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300'
                      : 'bg-gray-100 text-gray-400 dark:bg-gray-800'
                  }`}
                >
                  {i < currentStepIndex && '✓ '}{s.label}
                </span>
                {i < steps.length - 1 && (
                  <ChevronRight size={12} className="text-gray-300" />
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Step content ──────────────────────────────────────────────────── */}
      <div className="max-w-2xl mx-auto px-4 py-6 sm:px-6 sm:py-8">

        {/* Visually-hidden step heading for screen readers; receives focus on step change */}
        <h1
          ref={stepHeadingRef}
          tabIndex={-1}
          className="sr-only focus:not-sr-only focus:mb-4 focus:text-2xl focus:font-bold
            focus:text-gray-900 dark:focus:text-white focus:outline-none"
        >
          {steps[currentStepIndex]?.label}
        </h1>

        {/* ── STEP: rules ─────────────────────────────────────────────── */}
        {step === 'rules' && houseRules && (
          <div className="space-y-4">
            <StepHeader
              step={1}
              total={steps.length}
              title="House Rules"
              description="Please read and acknowledge the house rules before continuing."
            />
            <HouseRulesAcknowledgement
              rules={houseRules}
              acknowledged={!!rulesAcknowledgedAt}
              onAcknowledge={handleRulesAcknowledge}
            />
          </div>
        )}

        {/* ── STEP: terms ─────────────────────────────────────────────── */}
        {step === 'terms' && (
          <div className="space-y-4">
            <StepHeader
              step={currentStepIndex + 1}
              total={steps.length}
              title="Terms & Disclosures"
              description="Review and accept the terms to proceed."
            />
            <TermsDisclosure
              variant="booking"
              accepted={!!termsAcceptance}
              onAcceptanceChange={(acceptance) => {
                if (acceptance) handleTermsAccepted(acceptance);
              }}
            />
            {termsAcceptance && (
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => advance('terms')}
                  className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-medium
                    rounded-xl text-sm transition focus-visible:outline-none
                    focus-visible:ring-2 focus-visible:ring-blue-500"
                >
                  Continue
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── STEP: details ───────────────────────────────────────────── */}
        {step === 'details' && (
          <div className="space-y-4">
            <StepHeader
              step={currentStepIndex + 1}
              total={steps.length}
              title="Stay Details"
              description="Choose your dates and number of guests."
            />
            <BookingForm
              propertyId={propertyId}
              pricePerNight={100}
              onSubmit={handleFormSubmit}
              isLoading={false}
              disabled={false}
            />
          </div>
        )}

        {/* ── STEP: wallet ────────────────────────────────────────────── */}
        {step === 'wallet' && (
          <div className="space-y-4">
            <StepHeader
              step={currentStepIndex + 1}
              total={steps.length}
              title="Connect Wallet"
              description="Connect your Stellar wallet to pay with USDC held in escrow."
            />

            {walletConnected && walletAddress ? (
              <WalletCard
                address={walletAddress}
                onDisconnect={handleWalletDisconnect}
                onContinue={() => advance('wallet')}
              />
            ) : (
              <div className="rounded-xl border border-amber-200 dark:border-amber-800
                bg-amber-50 dark:bg-amber-950 p-5 space-y-4">
                <div className="flex items-start gap-3">
                  <Wallet size={20} className="text-amber-600 flex-shrink-0 mt-0.5" aria-hidden="true" />
                  <div>
                    <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                      {t('walletNotConnected')}
                    </p>
                    <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">
                      {t('walletNote')}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowWalletModal(true)}
                  className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold
                    py-3 px-4 rounded-xl text-sm transition
                    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                >
                  Connect Freighter Wallet
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── STEP: confirm ───────────────────────────────────────────── */}
        {step === 'confirm' && (
          <div className="space-y-4">
            <StepHeader
              step={currentStepIndex + 1}
              total={steps.length}
              title="Review & Confirm"
              description="Check everything looks right before paying."
            />

            {/* Summary card */}
            {formData && (
              <div className="rounded-xl border border-gray-200 dark:border-gray-700
                bg-white dark:bg-gray-900 divide-y divide-gray-100 dark:divide-gray-800">
                <SummaryRow label="Check-in"  value={new Date(formData.checkIn).toLocaleDateString()} />
                <SummaryRow label="Check-out" value={new Date(formData.checkOut).toLocaleDateString()} />
                <SummaryRow label="Guests"    value={String(formData.guestCount)} />
                <SummaryRow
                  label="Total"
                  value={`${formData.totalPrice.toFixed(2)} USDC`}
                  bold
                />
              </div>
            )}

            {/* Wallet confirmation */}
            {walletConnected && walletAddress ? (
              <WalletCard
                address={walletAddress}
                onDisconnect={handleWalletDisconnect}
              />
            ) : (
              <div className="rounded-xl border border-amber-200 dark:border-amber-800
                bg-amber-50 dark:bg-amber-950 p-4 flex items-start gap-3">
                <AlertCircle size={18} className="text-amber-600 flex-shrink-0 mt-0.5" aria-hidden="true" />
                <div>
                  <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                    Wallet not connected
                  </p>
                  <button
                    type="button"
                    onClick={() => setShowWalletModal(true)}
                    className="text-xs text-blue-600 dark:text-blue-400 underline mt-1"
                  >
                    Connect now
                  </button>
                </div>
              </div>
            )}

            {/* Submit error */}
            {submitError && (
              <div role="alert" className="flex items-start gap-2 p-3 rounded-lg
                bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800">
                <AlertCircle size={15} className="text-red-600 flex-shrink-0 mt-0.5" aria-hidden="true" />
                <p className="text-sm text-red-700 dark:text-red-300">{submitError}</p>
              </div>
            )}

            {/* Confirm CTA */}
            <button
              type="button"
              onClick={handleConfirm}
              disabled={isSubmitting || !walletConnected || !formData}
              aria-disabled={isSubmitting || !walletConnected || !formData}
              className="w-full bg-blue-600 hover:bg-blue-700 active:bg-blue-800
                disabled:bg-gray-300 dark:disabled:bg-gray-700 disabled:cursor-not-allowed
                text-white font-semibold py-3.5 px-4 rounded-xl text-base transition
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              {isSubmitting ? (
                <span className="flex items-center justify-center gap-2">
                  <Loader2 size={18} className="animate-spin" aria-hidden="true" />
                  {t('processing')}
                </span>
              ) : (
                'Confirm & Pay'
              )}
            </button>
          </div>
        )}
      </div>

      {/* ── Wallet modal ──────────────────────────────────────────────────── */}
      <WalletConnectionModal
        isOpen={showWalletModal}
        onClose={() => setShowWalletModal(false)}
        onConnect={handleWalletConnect}
      />
    </main>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StepHeader({
  step, total, title, description,
}: {
  step: number; total: number; title: string; description: string;
}) {
  return (
    <div className="mb-2">
      <p className="text-xs font-medium text-blue-600 dark:text-blue-400 uppercase tracking-wide mb-1">
        Step {step} of {total}
      </p>
      <h2 className="text-xl font-bold text-gray-900 dark:text-white">{title}</h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{description}</p>
    </div>
  );
}

function WalletCard({
  address, onDisconnect, onContinue,
}: {
  address: string;
  onDisconnect: () => void;
  onContinue?: () => void;
}) {
  return (
    <div className="rounded-xl border border-green-200 dark:border-green-800
      bg-green-50 dark:bg-green-950 p-4 space-y-3">
      <div className="flex items-start gap-3">
        <CheckCircle2 size={20} className="text-green-600 flex-shrink-0 mt-0.5" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-green-900 dark:text-green-200">
            Wallet connected
          </p>
          <p className="text-xs font-mono text-green-700 dark:text-green-400 mt-1 break-all">
            {address}
          </p>
          <button
            type="button"
            onClick={onDisconnect}
            className="text-xs text-green-600 dark:text-green-400 underline mt-1
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 rounded"
          >
            Disconnect
          </button>
        </div>
      </div>
      {onContinue && (
        <button
          type="button"
          onClick={onContinue}
          className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold
            py-3 px-4 rounded-xl text-sm transition
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          Continue
        </button>
      )}
    </div>
  );
}

function SummaryRow({
  label, value, bold = false,
}: {
  label: string; value: string; bold?: boolean;
}) {
  return (
    <div className="flex justify-between items-center px-4 py-3">
      <span className="text-sm text-gray-600 dark:text-gray-400">{label}</span>
      <span className={`text-sm ${bold ? 'font-bold text-blue-600 dark:text-blue-400' : 'font-medium text-gray-900 dark:text-white'}`}>
        {value}
      </span>
    </div>
  );
}
