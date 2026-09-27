'use client';

import { useEffect, useRef, useState } from 'react';
import { Calendar, Users, AlertCircle, ChevronDown, ChevronUp } from 'lucide-react';
import { useTranslations } from '@/lib/i18n/useTranslations';
import { useLocale } from '@/lib/i18n/useLocale';
import { formatCurrency } from '@/lib/i18n/formatting';
import { getErrorMessage, isApiError } from '@/lib/errors/errorCodes';
import { useCurrency } from '@/hooks/useCurrency';

interface BookingFormProps {
  propertyId: string;
  pricePerNight: number;
  maxGuests?: number;
  minStay?: number;
  maxStay?: number;
  onSubmit: (data: {
    checkIn: Date;
    checkOut: Date;
    guestCount: number;
    totalPrice: number;
  }) => void;
  isLoading?: boolean;
  /** When true the submit button is rendered but kept disabled (e.g. terms not accepted). */
  disabled?: boolean;
}

interface PriceQuote {
  base_nightly_rate: number;
  nights: number;
  subtotal: number;
  dynamic_adjustments: number;
  platform_fee_pct: number;
  platform_fee: number;
  total: number;
  breakdown: Array<{ date: string; price: number; is_available: boolean; reason?: string }>;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

export default function BookingForm({
  propertyId,
  maxGuests,
  minStay,
  maxStay,
  onSubmit,
  isLoading = false,
  disabled = false,
}: BookingFormProps) {
  const [checkIn, setCheckIn]   = useState('');
  const [checkOut, setCheckOut] = useState('');
  const [guestCount, setGuestCount] = useState(1);

  const [dateError, setDateError]                 = useState('');
  const [guestError, setGuestError]               = useState('');
  const [availabilityError, setAvailabilityError] = useState('');

  const [pricing, setPricing]           = useState<PriceQuote | null>(null);
  const [pricingLoading, setPricingLoading] = useState(false);
  const [breakdownOpen, setBreakdownOpen]   = useState(false);

  const errorRef = useRef<HTMLDivElement>(null);

  const t = useTranslations('booking');
  const { locale } = useLocale();
  const { formatEstimate, displayCurrency, ratesStale } = useCurrency();
  const today = new Date().toISOString().split('T')[0];

  // ── Fetch pricing quote whenever dates change ──────────────────────────────
  useEffect(() => {
    if (!checkIn || !checkOut) {
      setPricing(null);
      return;
    }

    const controller = new AbortController();
    setPricingLoading(true);

    const fetchPricing = async () => {
      try {
        const res = await fetch(
          `${API_URL}/api/v1/properties/${propertyId}/quote?start=${checkIn}&end=${checkOut}`,
          { signal: controller.signal },
        );

        if (res.ok) {
          setPricing(await res.json());
          setDateError('');
        } else {
          const body = await res.json().catch(() => ({}));
          setDateError(
            isApiError(body)
              ? getErrorMessage(body.error.code, body.error.message)
              : t('cantCalculatePrice'),
          );
          setPricing(null);
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        setDateError(t('cantCalculatePrice'));
        setPricing(null);
      } finally {
        setPricingLoading(false);
      }
    };

    fetchPricing();
    return () => controller.abort();
  }, [checkIn, checkOut, propertyId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Guest validation ───────────────────────────────────────────────────────
  const handleGuestChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value, 10);
    setGuestCount(isNaN(val) ? 0 : val);

    if (isNaN(val) || val < 1) {
      setGuestError('At least 1 guest is required');
    } else if (maxGuests !== undefined && val > maxGuests) {
      setGuestError(`Maximum ${maxGuests} guest${maxGuests === 1 ? '' : 's'} allowed`);
    } else {
      setGuestError('');
    }
  };

  // ── Submit ─────────────────────────────────────────────────────────────────
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setDateError('');
    setGuestError('');
    setAvailabilityError('');

    if (!checkIn || !checkOut) {
      setDateError(t('invalidDates'));
      errorRef.current?.focus();
      return;
    }

    if (new Date(checkIn) >= new Date(checkOut)) {
      setDateError(t('checkoutAfterCheckin'));
      errorRef.current?.focus();
      return;
    }

    const stayNights = Math.ceil(
      (new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 86400000,
    );

    if (minStay !== undefined && stayNights < minStay) {
      setDateError(`Minimum stay is ${minStay} night${minStay === 1 ? '' : 's'}`);
      errorRef.current?.focus();
      return;
    }

    if (maxStay !== undefined && stayNights > maxStay) {
      setDateError(`Maximum stay is ${maxStay} night${maxStay === 1 ? '' : 's'}`);
      errorRef.current?.focus();
      return;
    }

    if (guestCount < 1) {
      setGuestError('At least 1 guest is required');
      return;
    }

    if (maxGuests !== undefined && guestCount > maxGuests) {
      setGuestError(`Maximum ${maxGuests} guest${maxGuests === 1 ? '' : 's'} allowed`);
      return;
    }

    // Availability check
    try {
      const res = await fetch(
        `${API_URL}/api/v1/calendar/${propertyId}/check?checkIn=${checkIn}&checkOut=${checkOut}`,
      );
      if (res.ok) {
        const data = await res.json();
        if (!data.available) {
          setAvailabilityError(
            isApiError(data)
              ? getErrorMessage(data.error.code, data.error.message)
              : (data.reason || t('unavailableDates')),
          );
          errorRef.current?.focus();
          return;
        }
      }
    } catch {
      setDateError('Failed to check availability');
      errorRef.current?.focus();
      return;
    }

    if (!pricing) {
      setDateError(t('cantCalculatePrice'));
      errorRef.current?.focus();
      return;
    }

    if (pricing.breakdown.some((d) => !d.is_available)) {
      setDateError(t('hasBlockedDates'));
      errorRef.current?.focus();
      return;
    }

    onSubmit({
      checkIn:    new Date(checkIn),
      checkOut:   new Date(checkOut),
      guestCount,
      totalPrice: pricing.total,
    });
  };

  // ── Derived state ──────────────────────────────────────────────────────────
  const nights =
    checkIn && checkOut
      ? Math.ceil((new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 86400000)
      : 0;

  const stayViolation =
    nights > 0 &&
    ((minStay !== undefined && nights < minStay) || (maxStay !== undefined && nights > maxStay));

  const hasError      = !!(dateError || availabilityError);
  const isOverCapacity = maxGuests !== undefined && guestCount > maxGuests;
  const submitDisabled =
    disabled || isLoading || nights <= 0 || !pricing || pricingLoading ||
    !!guestError || isOverCapacity || stayViolation;

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      className="bg-white dark:bg-gray-900 rounded-xl shadow-md border border-gray-100 dark:border-gray-800 overflow-hidden"
    >
      {/* ── Section: Dates ──────────────────────────────────────────────── */}
      <div className="p-5 sm:p-6 space-y-4">
        <h2 className="text-base font-semibold text-gray-900 dark:text-white flex items-center gap-2">
          <Calendar size={16} aria-hidden="true" className="text-blue-600" />
          Stay dates
        </h2>

        {/* Date inputs — stack on mobile, side-by-side on sm+ */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label
              htmlFor="check-in"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              {t('checkIn')}
            </label>
            <input
              id="check-in"
              type="date"
              min={today}
              value={checkIn}
              onChange={(e) => setCheckIn(e.target.value)}
              aria-describedby={hasError ? 'date-error' : undefined}
              aria-invalid={hasError}
              required
              className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2.5
                bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm
                focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label
              htmlFor="check-out"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              {t('checkOut')}
            </label>
            <input
              id="check-out"
              type="date"
              min={checkIn || today}
              value={checkOut}
              onChange={(e) => setCheckOut(e.target.value)}
              aria-describedby={hasError ? 'date-error' : undefined}
              aria-invalid={hasError}
              required
              className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2.5
                bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm
                focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        {/* Date / availability error — announced via role=alert */}
        {hasError && (
          <div
            id="date-error"
            role="alert"
            tabIndex={-1}
            ref={errorRef}
            className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-950
              border border-red-200 dark:border-red-800 rounded-lg"
          >
            <AlertCircle size={15} className="text-red-600 flex-shrink-0 mt-0.5" aria-hidden="true" />
            <p className="text-sm text-red-700 dark:text-red-300">
              {dateError || availabilityError}
            </p>
          </div>
        )}

        {/* Night count hint */}
        {nights > 0 && !stayViolation && (
          <p className="text-xs text-gray-500 dark:text-gray-400" aria-live="polite">
            {nights} night{nights !== 1 ? 's' : ''}
            {minStay ? ` · minimum ${minStay}` : ''}
            {maxStay ? ` · maximum ${maxStay}` : ''}
          </p>
        )}
        {stayViolation && (
          <p className="text-xs text-amber-600 dark:text-amber-400" aria-live="polite">
            {minStay !== undefined && nights < minStay
              ? `Minimum stay is ${minStay} night${minStay === 1 ? '' : 's'}`
              : `Maximum stay is ${maxStay} night${maxStay === 1 ? '' : 's'}`}
          </p>
        )}
      </div>

      <hr className="border-gray-100 dark:border-gray-800" />

      {/* ── Section: Guests ─────────────────────────────────────────────── */}
      <div className="p-5 sm:p-6 space-y-3">
        <h2 className="text-base font-semibold text-gray-900 dark:text-white flex items-center gap-2">
          <Users size={16} aria-hidden="true" className="text-blue-600" />
          Guests
          {maxGuests !== undefined && (
            <span className="ml-1 text-xs font-normal text-gray-500 dark:text-gray-400">
              (max {maxGuests})
            </span>
          )}
        </h2>

        {/* Stepper on mobile; number input on desktop */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            aria-label="Decrease guest count"
            onClick={() => {
              const next = Math.max(1, guestCount - 1);
              setGuestCount(next);
              setGuestError('');
            }}
            className="w-9 h-9 rounded-full border border-gray-300 dark:border-gray-600
              flex items-center justify-center text-gray-700 dark:text-gray-200
              hover:bg-gray-100 dark:hover:bg-gray-700 transition
              focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none
              disabled:opacity-40"
            disabled={guestCount <= 1}
          >
            <span aria-hidden="true" className="text-lg leading-none">−</span>
          </button>

          <input
            id="guests"
            type="number"
            min="1"
            step="1"
            max={maxGuests}
            value={guestCount}
            onChange={handleGuestChange}
            aria-describedby={guestError ? 'guest-error' : undefined}
            aria-invalid={!!guestError}
            className={`w-16 text-center border rounded-lg px-2 py-2 text-sm
              bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100
              focus:outline-none focus:ring-2 focus:ring-blue-500
              ${guestError
                ? 'border-red-400 bg-red-50 dark:bg-red-950 dark:border-red-700'
                : 'border-gray-300 dark:border-gray-600'
              }`}
          />

          <button
            type="button"
            aria-label="Increase guest count"
            onClick={() => {
              const next = maxGuests !== undefined ? Math.min(maxGuests, guestCount + 1) : guestCount + 1;
              setGuestCount(next);
              if (maxGuests !== undefined && next > maxGuests) {
                setGuestError(`Maximum ${maxGuests} guest${maxGuests === 1 ? '' : 's'} allowed`);
              } else {
                setGuestError('');
              }
            }}
            className="w-9 h-9 rounded-full border border-gray-300 dark:border-gray-600
              flex items-center justify-center text-gray-700 dark:text-gray-200
              hover:bg-gray-100 dark:hover:bg-gray-700 transition
              focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none
              disabled:opacity-40"
            disabled={maxGuests !== undefined && guestCount >= maxGuests}
          >
            <span aria-hidden="true" className="text-lg leading-none">+</span>
          </button>
        </div>

        {guestError && (
          <p
            id="guest-error"
            role="alert"
            className="text-sm text-red-600 dark:text-red-400 flex items-center gap-1"
          >
            <AlertCircle size={13} aria-hidden="true" />
            {guestError}
          </p>
        )}
      </div>

      {/* ── Section: Pricing breakdown ───────────────────────────────────── */}
      {(pricing || pricingLoading) && (
        <>
          <hr className="border-gray-100 dark:border-gray-800" />

          <div className="p-5 sm:p-6 space-y-3">
            {/* Loading pulse */}
            {pricingLoading && !pricing && (
              <div aria-busy="true" aria-label="Calculating price" className="space-y-2">
                <div className="animate-pulse h-4 bg-gray-200 dark:bg-gray-700 rounded w-3/4" />
                <div className="animate-pulse h-4 bg-gray-200 dark:bg-gray-700 rounded w-1/2" />
                <div className="animate-pulse h-4 bg-gray-200 dark:bg-gray-700 rounded w-2/3" />
              </div>
            )}

            {pricing && (
              <>
                {/* USDC disclaimer */}
                {displayCurrency !== 'USD' && (
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    Charges are always in{' '}
                    <span className="font-semibold text-blue-600 dark:text-blue-400">USDC</span>.
                    {' '}Local-currency figures are{' '}
                    <span className="italic">estimates only</span>
                    {ratesStale && (
                      <span className="ml-1 text-amber-500 dark:text-amber-400">
                        (rates may be outdated)
                      </span>
                    )}
                    .
                  </p>
                )}

                {/* Collapsible per-night breakdown */}
                {pricing.breakdown.length > 0 && (
                  <div>
                    <button
                      type="button"
                      onClick={() => setBreakdownOpen((v) => !v)}
                      aria-expanded={breakdownOpen}
                      aria-controls="price-breakdown-detail"
                      className="flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400
                        hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
                    >
                      {breakdownOpen ? <ChevronUp size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
                      {breakdownOpen ? 'Hide' : 'Show'} nightly breakdown
                    </button>

                    {breakdownOpen && (
                      <div
                        id="price-breakdown-detail"
                        className="mt-2 max-h-32 overflow-y-auto text-xs space-y-1 pr-1"
                      >
                        {pricing.breakdown.map((day) => (
                          <div key={day.date} className="flex justify-between text-gray-600 dark:text-gray-400">
                            <span>{day.date}</span>
                            <span>
                              {day.is_available
                                ? `${formatCurrency(day.price, locale)} USDC`
                                : (day.reason ?? 'Unavailable')}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Summary lines */}
                <dl className="space-y-1.5 text-sm">
                  <div className="flex justify-between text-gray-600 dark:text-gray-400">
                    <dt>
                      {formatCurrency(pricing.base_nightly_rate, locale)} × {pricing.nights}{' '}
                      {pricing.nights === 1 ? 'night' : 'nights'}
                    </dt>
                    <dd className="font-medium text-gray-800 dark:text-gray-200">
                      {formatCurrency(pricing.subtotal, locale)} USDC
                      {displayCurrency !== 'USD' && formatEstimate(pricing.subtotal) && (
                        <span className="block text-xs text-gray-400 italic text-right">
                          {formatEstimate(pricing.subtotal)}
                        </span>
                      )}
                    </dd>
                  </div>

                  {pricing.dynamic_adjustments !== 0 && (
                    <div className="flex justify-between text-gray-600 dark:text-gray-400">
                      <dt>Dynamic pricing</dt>
                      <dd className="font-medium text-gray-800 dark:text-gray-200">
                        {pricing.dynamic_adjustments > 0 ? '+' : ''}
                        {formatCurrency(pricing.dynamic_adjustments, locale)} USDC
                      </dd>
                    </div>
                  )}

                  <div className="flex justify-between text-gray-600 dark:text-gray-400">
                    <dt>Platform fee ({(pricing.platform_fee_pct * 100).toFixed(0)}%)</dt>
                    <dd className="font-medium text-gray-800 dark:text-gray-200">
                      {formatCurrency(pricing.platform_fee, locale)} USDC
                    </dd>
                  </div>

                  <div className="flex justify-between pt-2 border-t border-gray-100 dark:border-gray-800 font-semibold text-gray-900 dark:text-white">
                    <dt>Total (USDC)</dt>
                    <dd className="text-blue-600 dark:text-blue-400">
                      {formatCurrency(pricing.total, locale)} USDC
                      {displayCurrency !== 'USD' && formatEstimate(pricing.total) && (
                        <span className="block text-xs font-normal text-gray-500 italic text-right">
                          {formatEstimate(pricing.total)} (estimate)
                        </span>
                      )}
                    </dd>
                  </div>
                </dl>
              </>
            )}
          </div>
        </>
      )}

      {/* ── Sticky submit footer ─────────────────────────────────────────── */}
      {/*
        On mobile the CTA sticks to the bottom of the viewport so it is always
        reachable without scrolling. On sm+ it flows naturally at the bottom
        of the card. The container uses position:sticky + bottom-0 but only
        takes effect when the card is taller than the viewport.
      */}
      <div className="sticky bottom-0 z-10 px-5 sm:px-6 py-4
        bg-white dark:bg-gray-900 border-t border-gray-100 dark:border-gray-800
        sm:static sm:border-none sm:pb-6 sm:pt-0 sm:bg-transparent dark:sm:bg-transparent">
        <button
          type="submit"
          disabled={submitDisabled}
          aria-disabled={submitDisabled}
          className="w-full bg-blue-600 hover:bg-blue-700 active:bg-blue-800
            disabled:bg-gray-300 dark:disabled:bg-gray-700
            disabled:cursor-not-allowed
            text-white font-semibold py-3 px-4 rounded-xl transition
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2
            text-base"
        >
          {isLoading
            ? t('processing')
            : disabled
            ? 'Accept terms to continue'
            : t('bookNow')}
        </button>
      </div>
    </form>
  );
}
