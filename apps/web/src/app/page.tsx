'use client';

import { useProperties } from '@/hooks/useProperties';
import { House } from 'lucide-react';
import PropertyGrid from '../components/search/PropertyGrid';

export default function Home() {
  const { properties, isLoading, error } = useProperties();

  return (
    <main className="min-h-screen bg-gray-50">
      <header className="bg-white border-b px-6 py-4 flex items-center gap-2">
        <House className="text-blue-600" size={24} />
        <span className="text-xl font-bold text-gray-900">Rentars</span>
        <span className="text-xs text-gray-400 ml-1">powered by Stellar</span>
      </header>

      <section className="max-w-7xl mx-auto px-6 py-8">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Find Your Next Rental</h1>
        <p className="text-gray-500 mb-6">
          Peer-to-peer rentals with instant USDC payments — no middlemen, no hidden fees.
        </p>

        {isLoading && <p className="text-gray-400">Loading properties...</p>}
        {error && <p className="text-red-500">{error}</p>}
        {!isLoading && (
          <>
            <p className="text-sm text-gray-500 mb-4">
              Showing {properties.length} properties
            </p>
            <PropertyGrid properties={properties} />
          </>
        )}
      </section>
    </main>
  );
}
