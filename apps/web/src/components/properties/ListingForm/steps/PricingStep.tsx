'use client';

import type { ListingFormData } from '../types';
import { formStyles } from '../styles';

interface PricingStepProps {
  formData: Partial<ListingFormData>;
  setFormData: (data: Partial<ListingFormData>) => void;
  errors: Record<string, string>;
}

export default function PricingStep({ formData, setFormData, errors }: PricingStepProps) {
  return (
    <div className="space-y-6">
      <div className={formStyles.formGroup}>
        <label className={formStyles.label}>Price per Night (USD)</label>
        <div className="flex items-center gap-2">
          <span className="text-xl font-semibold">$</span>
          <input
            type="number"
            value={formData.pricePerNight || ''}
            onChange={(e) => setFormData({ ...formData, pricePerNight: Number(e.target.value) })}
            placeholder="0"
            min="10"
            className={formStyles.input}
          />
        </div>
        {errors.pricePerNight && <p className={formStyles.error}>{errors.pricePerNight}</p>}
      </div>

      <div className={formStyles.formGroup}>
        <label className={formStyles.label}>Cleaning Fee (USD)</label>
        <div className="flex items-center gap-2">
          <span className="text-xl font-semibold">$</span>
          <input
            type="number"
            value={formData.cleaningFee || ''}
            onChange={(e) => setFormData({ ...formData, cleaningFee: Number(e.target.value) })}
            placeholder="0"
            min="0"
            className={formStyles.input}
          />
        </div>
        {errors.cleaningFee && <p className={formStyles.error}>{errors.cleaningFee}</p>}
      </div>

      <div className={formStyles.formGroup}>
        <label className={formStyles.label}>Service Fee (USD)</label>
        <div className="flex items-center gap-2">
          <span className="text-xl font-semibold">$</span>
          <input
            type="number"
            value={formData.serviceFee || ''}
            onChange={(e) => setFormData({ ...formData, serviceFee: Number(e.target.value) })}
            placeholder="0"
            min="0"
            className={formStyles.input}
          />
        </div>
        {errors.serviceFee && <p className={formStyles.error}>{errors.serviceFee}</p>}
      </div>

      <div className="p-4 bg-gray-50 rounded-lg">
        <p className="text-sm font-semibold mb-2">Pricing Summary</p>
        <div className="space-y-1 text-sm">
          <div className="flex justify-between">
            <span>Per Night:</span>
            <span>${formData.pricePerNight || 0}</span>
          </div>
          <div className="flex justify-between">
            <span>Cleaning Fee:</span>
            <span>${formData.cleaningFee || 0}</span>
          </div>
          <div className="flex justify-between">
            <span>Service Fee:</span>
            <span>${formData.serviceFee || 0}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
