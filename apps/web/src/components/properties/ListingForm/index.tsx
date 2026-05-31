'use client';

import { useState } from 'react';
import type { ListingFormData, ListingStep } from './types';
import { formStyles } from './styles';
import BasicInfoStep from './steps/BasicInfoStep';
import LocationStep from './steps/LocationStep';
import AmenitiesStep from './steps/AmenitiesStep';
import PhotosStep from './steps/PhotosStep';
import PricingStep from './steps/PricingStep';
import ReviewStep from './steps/ReviewStep';

const STEPS: ListingStep[] = ['basic', 'location', 'amenities', 'photos', 'pricing', 'review'];
const STEP_LABELS: Record<ListingStep, string> = {
  basic: 'Basic Info',
  location: 'Location',
  amenities: 'Amenities',
  photos: 'Photos',
  pricing: 'Pricing',
  review: 'Review',
};

export default function ListingForm() {
  const [currentStep, setCurrentStep] = useState<ListingStep>('basic');
  const [formData, setFormData] = useState<Partial<ListingFormData>>({
    amenities: [],
    images: [],
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

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
    try {
      const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
      const token = localStorage.getItem('token');

      const formDataToSend = new FormData();
      Object.entries(formData).forEach(([key, value]) => {
        if (key === 'images' && Array.isArray(value)) {
          value.forEach((file) => formDataToSend.append('images', file));
        } else if (key === 'amenities' && Array.isArray(value)) {
          formDataToSend.append('amenities', JSON.stringify(value));
        } else if (value !== undefined) {
          formDataToSend.append(key, String(value));
        }
      });

      const response = await fetch(`${API_URL}/api/properties`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
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
              STEPS.indexOf(step) <= currentStepIndex ? formStyles.stepActive : formStyles.stepInactive
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
          <PhotosStep formData={formData} setFormData={setFormData} errors={errors} />
        )}
        {currentStep === 'pricing' && (
          <PricingStep formData={formData} setFormData={setFormData} errors={errors} />
        )}
        {currentStep === 'review' && (
          <ReviewStep formData={formData} errors={errors} />
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
            <button onClick={handleNext} className={`${formStyles.button} ${formStyles.buttonPrimary}`}>
              Next
            </button>
          ) : (
            <button onClick={handleSubmit} className={`${formStyles.button} ${formStyles.buttonPrimary}`}>
              Submit Listing
            </button>
          )}
        </div>

        {errors.submit && <p className={formStyles.error}>{errors.submit}</p>}
      </div>
    </div>
  );
}
