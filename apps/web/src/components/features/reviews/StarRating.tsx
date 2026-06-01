'use client';

import { Star } from 'lucide-react';

interface StarRatingProps {
  rating: number;
  max?: number;
  interactive?: boolean;
  onChange?: (rating: number) => void;
  size?: number;
}

export default function StarRating({ rating, max = 5, interactive = false, onChange, size = 16 }: StarRatingProps) {
  return (
    <div className="flex gap-0.5">
      {Array.from({ length: max }, (_, i) => (
        <button
          key={i}
          type="button"
          disabled={!interactive}
          onClick={() => onChange?.(i + 1)}
          className={interactive ? 'cursor-pointer' : 'cursor-default'}
        >
          <Star
            size={size}
            className={i < rating ? 'fill-yellow-400 text-yellow-400' : 'text-gray-300'}
          />
        </button>
      ))}
    </div>
  );
}
