'use client';

import type { ListingFormData } from '../types';
import { formStyles } from '../styles';

interface ReviewStepProps {
  formData: Partial<ListingFormData>;
  errors: Record<string, string>;
}

export default function ReviewStep({ formData, errors }: ReviewStepProps) {
  return (
    <div className="space-y-6">
      <div className="bg-gray-50 p-6 rounded-lg space-y-4">
        <div>
          <p className="text-sm text-gray-600">Property Title</p>
          <p className="font-semibold">{formData.title}</p>
        </div>

        <div>
          <p className="text-sm text-gray-600">Description</p>
          <p className="text-gray-700">{formData.description}</p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-sm text-gray-600">Type</p>
            <p className="font-semibold capitalize">{formData.propertyType}</p>
          </div>
          <div>
            <p className="text-sm text-gray-600">Location</p>
            <p className="font-semibold">
              {formData.city}, {formData.state}
            </p>
          </div>
        </div>

        <div>
          <p className="text-sm text-gray-600">Amenities</p>
          <div className="flex flex-wrap gap-2 mt-2">
            {(formData.amenities || []).map((amenity) => (
              <span key={amenity} className="bg-blue-100 text-blue-800 px-3 py-1 rounded-full text-sm">
                {amenity}
              </span>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div>
            <p className="text-sm text-gray-600">Price/Night</p>
            <p className="font-semibold">${formData.pricePerNight}</p>
          </div>
          <div>
            <p className="text-sm text-gray-600">Cleaning Fee</p>
            <p className="font-semibold">${formData.cleaningFee}</p>
          </div>
          <div>
            <p className="text-sm text-gray-600">Service Fee</p>
            <p className="font-semibold">${formData.serviceFee}</p>
          </div>
        </div>

        <div>
          <p className="text-sm text-gray-600">Photos</p>
          <p className="font-semibold">{formData.images?.length || 0} uploaded</p>
        </div>
      </div>

      <div className="p-4 bg-blue-50 rounded-lg">
        <label className="flex items-start gap-3 cursor-pointer">
          <input type="checkbox" className={formStyles.checkbox} />
          <span className="text-sm">
            I agree to the Rentars terms of service and confirm that all information is accurate.
          </span>
        </label>
      </div>

      {errors.agreeToTerms && <p className={formStyles.error}>{errors.agreeToTerms}</p>}
    </div>
  );
}
