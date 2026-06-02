'use client';

import ReviewList from '@/components/features/reviews/ReviewList';
import type { ReviewItem } from '@/components/features/reviews/ReviewList';

interface PropertyReviewsSectionProps {
  reviews?: ReviewItem[];
  averageRating?: number;
}

export default function PropertyReviewsSection({ reviews = [], averageRating = 0 }: PropertyReviewsSectionProps) {
  return (
    <div className="bg-white p-6 rounded-lg border">
      <ReviewList reviews={reviews} averageRating={averageRating} />
    </div>
  );
}
