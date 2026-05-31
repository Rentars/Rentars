import { z } from 'zod';

export const listingFormSchema = z.object({
  title: z.string().min(5, 'Title must be at least 5 characters').max(100),
  description: z.string().min(20, 'Description must be at least 20 characters').max(2000),
  propertyType: z.enum(['apartment', 'house', 'villa', 'condo', 'studio']),
  address: z.string().min(5, 'Address is required'),
  city: z.string().min(2, 'City is required'),
  state: z.string().min(2, 'State is required'),
  zipCode: z.string().regex(/^\d{5}(-\d{4})?$/, 'Invalid zip code'),
  amenities: z.array(z.string()).min(1, 'Select at least one amenity'),
  images: z.array(z.instanceof(File)).min(1, 'Upload at least one image'),
  pricePerNight: z.number().min(10, 'Price must be at least $10'),
  cleaningFee: z.number().min(0),
  serviceFee: z.number().min(0),
  agreeToTerms: z.boolean().refine((val) => val === true, 'You must agree to terms'),
});

export type ListingFormSchema = z.infer<typeof listingFormSchema>;
