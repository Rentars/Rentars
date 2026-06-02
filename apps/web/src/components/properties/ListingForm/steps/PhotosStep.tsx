'use client';

import ImageUploader from '@/components/features/properties/ImageUploader';
import type { ListingFormData } from '../types';

interface PhotosStepProps {
  formData: Partial<ListingFormData>;
  setFormData: (data: Partial<ListingFormData>) => void;
  errors: Record<string, string>;
}

export default function PhotosStep({ formData, setFormData, errors }: PhotosStepProps) {
  return (
    <div className="space-y-6">
      <ImageUploader
        onChange={(images) =>
          setFormData({ ...formData, images: images.map((img) => img.file!).filter(Boolean) })
        }
        maxImages={10}
      />
      {errors.images && <p className="text-sm text-red-600 mt-1">{errors.images}</p>}
    </div>
  );
}
