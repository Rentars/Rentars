'use client';

import type { ListingFormData } from '../types';
import { formStyles } from '../styles';

interface BasicInfoStepProps {
  formData: Partial<ListingFormData>;
  setFormData: (data: Partial<ListingFormData>) => void;
  errors: Record<string, string>;
}

export default function BasicInfoStep({ formData, setFormData, errors }: BasicInfoStepProps) {
  return (
    <div className="space-y-6">
      <div className={formStyles.formGroup}>
        <label className={formStyles.label}>Property Title</label>
        <input
          type="text"
          value={formData.title || ''}
          onChange={(e) => setFormData({ ...formData, title: e.target.value })}
          placeholder="e.g., Cozy Downtown Apartment"
          className={formStyles.input}
        />
        {errors.title && <p className={formStyles.error}>{errors.title}</p>}
      </div>

      <div className={formStyles.formGroup}>
        <label className={formStyles.label}>Description</label>
        <textarea
          value={formData.description || ''}
          onChange={(e) => setFormData({ ...formData, description: e.target.value })}
          placeholder="Describe your property..."
          rows={5}
          className={formStyles.textarea}
        />
        {errors.description && <p className={formStyles.error}>{errors.description}</p>}
      </div>

      <div className={formStyles.formGroup}>
        <label className={formStyles.label}>Property Type</label>
        <select
          value={formData.propertyType || ''}
          onChange={(e) => setFormData({ ...formData, propertyType: e.target.value })}
          className={formStyles.select}
        >
          <option value="">Select a type</option>
          <option value="apartment">Apartment</option>
          <option value="house">House</option>
          <option value="villa">Villa</option>
          <option value="condo">Condo</option>
          <option value="studio">Studio</option>
        </select>
        {errors.propertyType && <p className={formStyles.error}>{errors.propertyType}</p>}
      </div>
    </div>
  );
}
