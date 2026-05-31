'use client';

import type { ListingFormData } from '../types';
import { formStyles } from '../styles';

interface LocationStepProps {
  formData: Partial<ListingFormData>;
  setFormData: (data: Partial<ListingFormData>) => void;
  errors: Record<string, string>;
}

export default function LocationStep({ formData, setFormData, errors }: LocationStepProps) {
  return (
    <div className="space-y-6">
      <div className={formStyles.formGroup}>
        <label className={formStyles.label}>Address</label>
        <input
          type="text"
          value={formData.address || ''}
          onChange={(e) => setFormData({ ...formData, address: e.target.value })}
          placeholder="Street address"
          className={formStyles.input}
        />
        {errors.address && <p className={formStyles.error}>{errors.address}</p>}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className={formStyles.formGroup}>
          <label className={formStyles.label}>City</label>
          <input
            type="text"
            value={formData.city || ''}
            onChange={(e) => setFormData({ ...formData, city: e.target.value })}
            placeholder="City"
            className={formStyles.input}
          />
          {errors.city && <p className={formStyles.error}>{errors.city}</p>}
        </div>

        <div className={formStyles.formGroup}>
          <label className={formStyles.label}>State</label>
          <input
            type="text"
            value={formData.state || ''}
            onChange={(e) => setFormData({ ...formData, state: e.target.value })}
            placeholder="State"
            className={formStyles.input}
          />
          {errors.state && <p className={formStyles.error}>{errors.state}</p>}
        </div>
      </div>

      <div className={formStyles.formGroup}>
        <label className={formStyles.label}>Zip Code</label>
        <input
          type="text"
          value={formData.zipCode || ''}
          onChange={(e) => setFormData({ ...formData, zipCode: e.target.value })}
          placeholder="12345"
          className={formStyles.input}
        />
        {errors.zipCode && <p className={formStyles.error}>{errors.zipCode}</p>}
      </div>

      <div className="p-4 bg-blue-50 rounded-lg text-sm text-blue-900">
        <p className="font-semibold mb-2">Map-based location picking</p>
        <p>Click on the map below to set your property's exact coordinates (optional)</p>
      </div>
    </div>
  );
}
