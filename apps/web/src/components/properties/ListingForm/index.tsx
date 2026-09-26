'use client';

import { useState } from 'react';
import type { ListingFormData, ListingStep } from './types';
import { formStyles } from './styles';
import BasicInfoStep from './steps/BasicInfoStep';
import LocationStep from './steps/LocationStep';
import AmenitiesStep from './steps/AmenitiesStep';
import PhotosStep from './steps/PhotosStep';
import PricingStep from './steps/PricingStep';
import HouseRulesStep from './steps/HouseRulesStep';
import ReviewStep from './steps/ReviewStep';
import { TermsDisclosure, type TermsAcceptance } from '@/components/shared/TermsDisclosure';

const STEPS: ListingStep[] = [
  'basic',
  'location',
  'amenities',
  'photos',
  'pricing',
  'rules',
  'review',
];

const STEP_LABELS: Record<ListingStep, string> = {
  basic: 'Basic Info',
  location: 'Location',
  amenities: 'Amenities',
  photos: 'Photos',
  pricing: 'Pricing',
  rules: 'House Rules',
  review: 'Review',
};

export default function ListingForm() {
  const [currentStep, setCurrentStep] = useState<ListingStep>('basic');
  const [formData, setFormData] = useState<Partial<ListingFormData>>({
    amenities: [],
    images: [],
    maxGuests: 1,
    bedrooms: 0,
    bathrooms: 0,
    petsAllowed: false,
    smokingAllowed: false,
    eventsAllowed: false,
    quietHoursStart: '',
    quietHoursEnd: '',
    additionalRules: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [uploadsInProgress, setUploadsInProgress] = useState(false);
  const [termsAcceptance, setTermsAcceptance] = useState<TermsAcceptance | null>(null);

  const currentStepIndex = STEPS.indexOf(currentStep);

  const handleNext = () => {
    if (currentStepIndex < STEPS.length - 1) {
      setCurrentStep(STEPS[currentStepIndex + 1]);
    }
  };

  const handlePrevious = () => {
    if (currentStepIndex > 0) {
      setCurrentStep(STEPS[currentStepIndex - 1]);
    }
  };

  const handleSubmit = async () => {
    if (!termsAcceptance) {
      setErrors({ submit: 'You must accept the platform terms before publishing your listing.' });
      return;
    }

    try {
      const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
      const token = localStorage.getItem('token');

      const formDataToSend = new FormData();
      Object.entries(formData).forEach(([key, value]) => {
        if (key === 'images' && Array.isArray(value)) {
          value.forEach((file) => formDataToSend.append('images', file));
        } else if (key === 'amenities' && Array.isArray(value)) {
          formDataToSend.append('amenities', JSON.stringify(value));
        } else if (typeof value === 'boolean') {
          formDataToSend.append(key, String(value));
        } else if (value !== undefined) {
          formDataToSend.append(key, String(value));
        }
      });
      // Record terms acceptance alongside the listing
      formDataToSend.append('terms_version', termsAcceptance.termsVersion);
      formDataToSend.append('terms_accepted_at', termsAcceptance.termsAcceptedAt);

      const response = await fetch(`${API_URL}/api/properties`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formDataToSend,
      });

      if (!response.ok) throw new Error('Failed to create listing');

      const property = await response.json();

      // Trigger on-chain registration via Freighter
      if (window.freighter) {
        await window.freighter.signTransaction({
          xdr: property.xdr,
          publicKey: localStorage.getItem('publicKey'),
        });
      }

      alert('Property listed successfully!');
      window.location.href = '/dashboard';
    } catch (error) {
      setErrors({ submit: error instanceof Error ? error.message : 'Failed to submit' });
    }
  };

  return (
    <div className={formStyles.container}>
      {/* Step Indicator */}
      <div className={formStyles.stepIndicator}>
        {STEPS.map((step) => (
          <div
            key={step}
            className={`${formStyles.step} ${
              STEPS.indexOf(step) <= currentStepIndex
                ? formStyles.stepActive
                : formStyles.stepInactive
            }`}
            title={STEP_LABELS[step]}
          />
        ))}
      </div>

      {/* Current Step */}
      <div className={formStyles.section}>
        <h2 className={formStyles.heading}>{STEP_LABELS[currentStep]}</h2>

        {currentStep === 'basic' && (
          <BasicInfoStep formData={formData} setFormData={setFormData} errors={errors} />
        )}
        {currentStep === 'location' && (
          <LocationStep formData={formData} setFormData={setFormData} errors={errors} />
        )}
        {currentStep === 'amenities' && (
          <AmenitiesStep formData={formData} setFormData={setFormData} errors={errors} />
        )}
        {currentStep === 'photos' && (
          <PhotosStep
            formData={formData}
            setFormData={setFormData}
            errors={errors}
            onUploadStatusChange={setUploadsInProgress}
          />
        )}
        {currentStep === 'pricing' && (
          <PricingStep formData={formData} setFormData={setFormData} errors={errors} />
        )}
        {currentStep === 'rules' && (
          <HouseRulesStep formData={formData} setFormData={setFormData} errors={errors} />
        )}
        {currentStep === 'review' && (
          <ReviewStep formData={formData} errors={errors} />
        )}

        {/* Terms — shown on final review step only */}
        {currentStep === 'review' && (
          <div className="mt-6">
            <TermsDisclosure
              variant="listing"
              accepted={!!termsAcceptance}
              onAcceptanceChange={setTermsAcceptance}
            />
          </div>
        )}

        {/* Navigation */}
        <div className="flex gap-4 mt-8">
          <button
            onClick={handlePrevious}
            disabled={currentStepIndex === 0}
            className={`${formStyles.button} ${formStyles.buttonSecondary} disabled:opacity-50`}
          >
            Previous
          </button>
          {currentStepIndex < STEPS.length - 1 ? (
            <button
              onClick={handleNext}
              disabled={currentStep === 'photos' && uploadsInProgress}
              className={`${formStyles.button} ${formStyles.buttonPrimary} ${
                currentStep === 'photos' && uploadsInProgress ? 'opacity-50 cursor-not-allowed' : ''
              }`}
            >
              Next
            </button>
          ) : (
            <button
              onClick={handleSubmit}
              disabled={currentStep === 'review' && !termsAcceptance}
              className={`${formStyles.button} ${formStyles.buttonPrimary} ${
                currentStep === 'review' && !termsAcceptance ? 'opacity-50 cursor-not-allowed' : ''
              }`}
            >
              Submit Listing
            </button>
          )}
        </div>

        {errors.submit && <p className={formStyles.error}>{errors.submit}</p>}
      </div>
    </div>
  );
}
