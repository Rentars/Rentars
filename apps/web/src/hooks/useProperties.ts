'use client';

import { useEffect, useState } from 'react';
import type { Property } from '../types/property';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

export function useProperties() {
  const [properties, setProperties] = useState<Property[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API_URL}/api/properties`)
      .then((r) => r.json())
      .then((data) => setProperties(data))
      .catch(() => setError('Failed to load properties'))
      .finally(() => setIsLoading(false));
  }, []);

  return { properties, isLoading, error };
}
