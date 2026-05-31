export interface ListingFormData {
  // Basic Info
  title: string;
  description: string;
  propertyType: string;

  // Location
  address: string;
  city: string;
  state: string;
  zipCode: string;
  latitude?: number;
  longitude?: number;

  // Amenities
  amenities: string[];

  // Photos
  images: File[];

  // Pricing
  pricePerNight: number;
  cleaningFee: number;
  serviceFee: number;

  // Review
  agreeToTerms: boolean;
}

export type ListingStep = 'basic' | 'location' | 'amenities' | 'photos' | 'pricing' | 'review';
