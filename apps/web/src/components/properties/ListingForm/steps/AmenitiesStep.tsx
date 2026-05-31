'use client';

import type { ListingFormData } from '../types';
import { formStyles } from '../styles';

interface AmenitiesStepProps {
  formData: Partial<ListingFormData>;
  setFormData: (data: Partial<ListingFormData>) => void;
  errors: Record<string, string>;
}

const AMENITIES = [
  'WiFi',
  'Kitchen',
  'Parking',
  'Pool',
  'Gym',
  'Washer',
  'Dryer',
  'Air Conditioning',
  'Heating',
  'TV',
  'Dishwasher',
  'Microwave',
];

export default function AmenitiesStep({ formData, setFormData, errors }: AmenitiesStepProps) {
  const toggleAmenity = (amenity: string) => {
    const current = formData.amenities || [];
    const updated = current.includes(amenity)
      ? current.filter((a) => a !== amenity)
      : [...current, amenity];
    setFormData({ ...formData, amenities: updated });
  };

  return (
    <div className="space-y-6">
      <p className="text-gray-600">Select all amenities your property offers</p>

      <div className="grid grid-cols-2 gap-4">
        {AMENITIES.map((amenity) => (
          <label key={amenity} className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={(formData.amenities || []).includes(amenity)}
              onChange={() => toggleAmenity(amenity)}
              className={formStyles.checkbox}
            />
            <span>{amenity}</span>
          </label>
        ))}
      </div>

      {errors.amenities && <p className={formStyles.error}>{errors.amenities}</p>}
    </div>
  );
}
