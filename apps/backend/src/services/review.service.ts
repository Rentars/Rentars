import { supabase } from '../config/supabase.js';
import type { ServiceResponse } from './index.js';

export interface Review {
  id: string;
  booking_id: string;
  reviewer_id: string;
  target_id: string;
  property_id?: string;
  rating: number;
  comment?: string;
  on_chain_id?: number;
  created_at?: string;
}

export async function submitReview(
  bookingId: string,
  reviewerId: string,
  targetId: string,
  rating: number,
  comment: string,
  propertyId?: string,
): Promise<ServiceResponse<Review>> {
  if (rating < 1 || rating > 5) {
    return { success: false, error: 'Rating must be between 1 and 5' };
  }

  // Verify booking belongs to reviewer
  const { data: booking, error: bookingError } = await supabase
    .from('bookings')
    .select('id, status')
    .eq('id', bookingId)
    .eq('tenant_id', reviewerId)
    .single();

  if (bookingError || !booking) {
    return { success: false, error: 'Booking not found or not owned by reviewer' };
  }

  const { data, error } = await supabase
    .from('reviews')
    .insert({ booking_id: bookingId, reviewer_id: reviewerId, target_id: targetId, property_id: propertyId, rating, comment })
    .select()
    .single();

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true, data: data as Review };
}

export async function getReviewsForProperty(propertyId: string): Promise<ServiceResponse<Review[]>> {
  const { data, error } = await supabase
    .from('reviews')
    .select('*')
    .eq('property_id', propertyId)
    .order('created_at', { ascending: false });

  if (error) return { success: false, error: error.message };
  return { success: true, data: (data ?? []) as Review[] };
}

export async function getReviewsForUser(userId: string): Promise<ServiceResponse<Review[]>> {
  const { data, error } = await supabase
    .from('reviews')
    .select('*')
    .eq('target_id', userId)
    .order('created_at', { ascending: false });

  if (error) return { success: false, error: error.message };
  return { success: true, data: (data ?? []) as Review[] };
}

export async function getAverageRating(userId: string): Promise<ServiceResponse<number>> {
  const { data, error } = await supabase
    .from('reviews')
    .select('rating')
    .eq('target_id', userId);

  if (error) return { success: false, error: error.message };
  if (!data || data.length === 0) return { success: true, data: 0 };

  const avg = (data as { rating: number }[]).reduce((sum, r) => sum + r.rating, 0) / data.length;
  return { success: true, data: Math.round(avg * 10) / 10 };
}
