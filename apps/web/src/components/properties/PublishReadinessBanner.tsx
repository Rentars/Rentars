'use client';

import { useEffect, useState } from 'react';
import { CheckCircle, AlertCircle, Loader2 } from 'lucide-react';

interface ReadinessResult {
  ready: boolean;
  missingFields: string[];
  imageCount: number;
}

/** Human-readable labels for missing field keys */
const FIELD_LABELS: Record<string, { label: string; step?: string }> = {
  title:           { label: 'Property title',      step: 'basic' },
  price_per_night: { label: 'Nightly price',        step: 'pricing' },
  city:            { label: 'City',                 step: 'location' },
  country:         { label: 'Country',              step: 'location' },
  bedrooms:        { label: 'Bedroom count',        step: 'details' },
  bathrooms:       { label: 'Bathroom count',       step: 'details' },
  max_guests:      { label: 'Maximum guests',       step: 'details' },
  images:          { label: 'At least one photo',  step: 'photos' },
  min_nights:      { label: 'Minimum stay nights', step: 'pricing' },
  max_nights:      { label: 'Maximum stay nights', step: 'pricing' },
  check_in_time:   { label: 'Check-in time',       step: 'pricing' },
  check_out_time:  { label: 'Check-out time',       step: 'pricing' },
};

interface Props {
  propertyId: string;
  /** Called when the host clicks a step link — navigate to that step */
  onGoToStep?: (step: string) => void;
  /** Refresh counter — increment to re-fetch readiness */
  refreshKey?: number;
}

export default function PublishReadinessBanner({ propertyId, onGoToStep, refreshKey = 0 }: Props) {
  const [result, setResult] = useState<ReadinessResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!propertyId) return;
    setLoading(true);
    setError(null);

    const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
    const headers: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {};

    fetch(`/api/v1/properties/${propertyId}/publish-readiness`, { headers })
      .then(async (res) => {
        if (!res.ok) throw new Error('Failed to load readiness');
        return res.json() as Promise<ReadinessResult>;
      })
      .then(setResult)
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [propertyId, refreshKey]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 py-2">
        <Loader2 size={14} className="animate-spin" aria-hidden="true" />
        Checking publish readiness…
      </div>
    );
  }

  if (error || !result) {
    return null; // fail silently — readiness is advisory
  }

  if (result.ready) {
    return (
      <div
        role="status"
        className="flex items-center gap-2 rounded-lg border border-green-200 dark:border-green-800
          bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-300 px-4 py-3 text-sm"
      >
        <CheckCircle size={16} aria-hidden="true" />
        Your listing meets all requirements and is ready to publish.
      </div>
    );
  }

  return (
    <div
      role="alert"
      className="rounded-lg border border-amber-200 dark:border-amber-800
        bg-amber-50 dark:bg-amber-950/30 px-4 py-3 text-sm"
    >
      <div className="flex items-start gap-2">
        <AlertCircle size={16} className="text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" aria-hidden="true" />
        <div>
          <p className="font-medium text-amber-800 dark:text-amber-200 mb-2">
            Complete the following before publishing:
          </p>
          <ul className="space-y-1">
            {result.missingFields.map((field) => {
              const info = FIELD_LABELS[field] ?? { label: field };
              return (
                <li key={field} className="flex items-center gap-1.5 text-amber-700 dark:text-amber-300">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500 dark:bg-amber-400 flex-shrink-0" aria-hidden="true" />
                  {info.step && onGoToStep ? (
                    <button
                      type="button"
                      onClick={() => onGoToStep(info.step!)}
                      className="underline underline-offset-2 hover:no-underline focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                    >
                      {info.label}
                    </button>
                  ) : (
                    <span>{info.label}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}
