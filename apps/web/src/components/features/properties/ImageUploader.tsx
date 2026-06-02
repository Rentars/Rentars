'use client';

import { useCallback, useState } from 'react';
import { Upload, X, Star } from 'lucide-react';

interface ImageItem {
  id?: string;
  url: string;
  file?: File;
  isPrimary?: boolean;
}

interface ImageUploaderProps {
  propertyId?: string;
  initialImages?: ImageItem[];
  onChange?: (images: ImageItem[]) => void;
  maxImages?: number;
}

/**
 * ImageUploader provides drag-and-drop image upload with preview, reordering,
 * primary image selection, and deletion. When propertyId is provided it syncs
 * with the backend API; otherwise it operates in local-only mode (for new listings).
 */
export default function ImageUploader({
  propertyId,
  initialImages = [],
  onChange,
  maxImages = 10,
}: ImageUploaderProps) {
  const [images, setImages] = useState<ImageItem[]>(initialImages);
  const [draggingOver, setDraggingOver] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

  const notify = (updated: ImageItem[]) => {
    setImages(updated);
    onChange?.(updated);
  };

  const addFiles = useCallback(
    async (files: File[]) => {
      const remaining = maxImages - images.length;
      const toAdd = files.slice(0, remaining);

      if (propertyId) {
        const token = localStorage.getItem('token');
        const uploaded: ImageItem[] = [];

        for (const file of toAdd) {
          const form = new FormData();
          form.append('image', file);
          const res = await fetch(`${API_URL}/api/v1/properties/${propertyId}/images`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body: form,
          });
          if (res.ok) {
            const img = await res.json();
            uploaded.push({ id: img.id, url: img.url, isPrimary: img.is_primary });
          }
        }

        notify([...images, ...uploaded]);
      } else {
        // Local mode: create object URLs for preview
        const newItems: ImageItem[] = toAdd.map((file, i) => ({
          url: URL.createObjectURL(file),
          file,
          isPrimary: images.length + i === 0,
        }));
        notify([...images, ...newItems]);
      }
    },
    [images, propertyId, maxImages],
  );

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    addFiles(files);
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDraggingOver(false);
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
    addFiles(files);
  };

  const removeImage = async (index: number) => {
    const img = images[index];

    if (propertyId && img.id) {
      const token = localStorage.getItem('token');
      await fetch(`${API_URL}/api/v1/properties/${propertyId}/images/${img.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
    }

    const updated = images.filter((_, i) => i !== index);
    // If removed image was primary, promote first
    if (img.isPrimary && updated.length > 0) {
      updated[0].isPrimary = true;
    }
    notify(updated);
  };

  const setPrimary = async (index: number) => {
    const img = images[index];

    if (propertyId && img.id) {
      const token = localStorage.getItem('token');
      await fetch(`${API_URL}/api/v1/properties/${propertyId}/images/${img.id}/primary`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` },
      });
    }

    const updated = images.map((item, i) => ({ ...item, isPrimary: i === index }));
    notify(updated);
  };

  // Drag-to-reorder handlers
  const handleDragStart = (index: number) => setDragIndex(index);

  const handleDropOnItem = (e: React.DragEvent, targetIndex: number) => {
    e.preventDefault();
    if (dragIndex === null || dragIndex === targetIndex) return;

    const updated = [...images];
    const [moved] = updated.splice(dragIndex, 1);
    updated.splice(targetIndex, 0, moved);
    setDragIndex(null);
    notify(updated);
  };

  return (
    <div className="space-y-4" aria-label="Image uploader">
      {/* Drop zone */}
      <div
        role="button"
        tabIndex={0}
        aria-label="Upload images by clicking or dragging files here"
        onDragOver={(e) => { e.preventDefault(); setDraggingOver(true); }}
        onDragLeave={() => setDraggingOver(false)}
        onDrop={handleDrop}
        onClick={() => document.getElementById('image-file-input')?.click()}
        onKeyDown={(e) => e.key === 'Enter' && document.getElementById('image-file-input')?.click()}
        className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition ${
          draggingOver ? 'border-blue-500 bg-blue-50' : 'border-gray-300 hover:border-blue-400'
        } ${images.length >= maxImages ? 'opacity-50 pointer-events-none' : ''}`}
      >
        <Upload size={32} className="mx-auto text-gray-400 mb-2" aria-hidden="true" />
        <p className="font-semibold text-gray-700">Drag & drop or click to upload</p>
        <p className="text-sm text-gray-500 mt-1">JPEG, PNG, WebP up to 5 MB ({images.length}/{maxImages})</p>
        <input
          id="image-file-input"
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp"
          onChange={handleFileInput}
          className="hidden"
          aria-hidden="true"
        />
      </div>

      {/* Image grid */}
      {images.length > 0 && (
        <div className="grid grid-cols-3 gap-3" role="list" aria-label="Uploaded images">
          {images.map((img, idx) => (
            <div
              key={img.id ?? img.url}
              role="listitem"
              draggable
              onDragStart={() => handleDragStart(idx)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => handleDropOnItem(e, idx)}
              className="relative group rounded-lg overflow-hidden border border-gray-200 aspect-video bg-gray-100 cursor-grab"
              aria-label={`Image ${idx + 1}${img.isPrimary ? ' (primary)' : ''}`}
            >
              <img
                src={img.url}
                alt={`Property image ${idx + 1}`}
                className="w-full h-full object-cover"
              />

              {/* Primary badge */}
              {img.isPrimary && (
                <span className="absolute top-1 left-1 bg-yellow-400 text-yellow-900 text-xs font-semibold px-1.5 py-0.5 rounded">
                  Primary
                </span>
              )}

              {/* Actions overlay */}
              <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition flex items-center justify-center gap-2">
                {!img.isPrimary && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setPrimary(idx); }}
                    className="p-1.5 bg-yellow-400 rounded-full hover:bg-yellow-500 transition"
                    aria-label="Set as primary image"
                    title="Set as primary"
                  >
                    <Star size={14} className="text-yellow-900" aria-hidden="true" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); removeImage(idx); }}
                  className="p-1.5 bg-red-500 rounded-full hover:bg-red-600 transition"
                  aria-label={`Remove image ${idx + 1}`}
                  title="Remove"
                >
                  <X size={14} className="text-white" aria-hidden="true" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
