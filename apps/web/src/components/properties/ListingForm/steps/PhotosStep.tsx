'use client';

import { useRef } from 'react';
import { Upload, X } from 'lucide-react';
import type { ListingFormData } from '../types';
import { formStyles } from '../styles';

interface PhotosStepProps {
  formData: Partial<ListingFormData>;
  setFormData: (data: Partial<ListingFormData>) => void;
  errors: Record<string, string>;
}

export default function PhotosStep({ formData, setFormData, errors }: PhotosStepProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const current = formData.images || [];
    setFormData({ ...formData, images: [...current, ...files] });
  };

  const removeImage = (index: number) => {
    const updated = (formData.images || []).filter((_, i) => i !== index);
    setFormData({ ...formData, images: updated });
  };

  return (
    <div className="space-y-6">
      <div
        onClick={() => fileInputRef.current?.click()}
        className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center cursor-pointer hover:border-blue-500 transition"
      >
        <Upload size={32} className="mx-auto text-gray-400 mb-2" />
        <p className="font-semibold mb-1">Click to upload photos</p>
        <p className="text-sm text-gray-500">or drag and drop</p>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*"
          onChange={handleFileSelect}
          className="hidden"
        />
      </div>

      {(formData.images || []).length > 0 && (
        <div>
          <p className="font-semibold mb-4">
            {formData.images?.length} photo{formData.images?.length !== 1 ? 's' : ''} uploaded
          </p>
          <div className="grid grid-cols-3 gap-4">
            {formData.images?.map((file, idx) => (
              <div key={idx} className="relative group">
                <img
                  src={URL.createObjectURL(file)}
                  alt={`Preview ${idx + 1}`}
                  className="w-full h-32 object-cover rounded-lg"
                />
                <button
                  onClick={() => removeImage(idx)}
                  className="absolute top-2 right-2 bg-red-600 text-white p-1 rounded-full opacity-0 group-hover:opacity-100 transition"
                >
                  <X size={16} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {errors.images && <p className={formStyles.error}>{errors.images}</p>}
    </div>
  );
}
