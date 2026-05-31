'use client';

import { useState } from 'react';
import type { ListingFormData, ListingStep } from '@/components/properties/ListingForm/types';

const STEPS: ListingStep[] = ['basic', 'location', 'amenities', 'photos', 'pricing', 'review'];

export function useListingForm() {
  const [currentStep, setCurrentStep] = useState<ListingStep>('basic');
  const [formData, setFormData] = useState<Partial<ListingFormData>>({
    amenities: [],
    images: [],
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const currentStepIndex = STEPS.indexOf(currentStep);

  const goToStep = (step: ListingStep) => {
    setCurrentStep(step);
  };

  const nextStep = () => {
    if (currentStepIndex < STEPS.length - 1) {
      setCurrentStep(STEPS[currentStepIndex + 1]);
    }
  };

  const previousStep = () => {
    if (currentStepIndex > 0) {
      setCurrentStep(STEPS[currentStepIndex - 1]);
    }
  };

  const updateFormData = (data: Partial<ListingFormData>) => {
    setFormData((prev) => ({ ...prev, ...data }));
  };

  const setError = (field: string, message: string) => {
    setErrors((prev) => ({ ...prev, [field]: message }));
  };

  const clearError = (field: string) => {
    setErrors((prev) => {
      const newErrors = { ...prev };
      delete newErrors[field];
      return newErrors;
    });
  };

  return {
    currentStep,
    currentStepIndex,
    formData,
    errors,
    goToStep,
    nextStep,
    previousStep,
    updateFormData,
    setError,
    clearError,
  };
}
