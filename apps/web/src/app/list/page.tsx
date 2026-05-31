'use client';

import { RoleGuard } from '@/components/guards/RoleGuard';
import ListingForm from '@/components/properties/ListingForm';

export default function ListPage() {
  return (
    <RoleGuard requiredRoles={['host', 'admin']}>
      <main className="min-h-screen bg-gray-50 py-8">
        <div className="max-w-2xl mx-auto px-6">
          <h1 className="text-3xl font-bold mb-2">List Your Property</h1>
          <p className="text-gray-600 mb-8">
            Get your property on Rentars and start earning with instant USDC payments.
          </p>
          <ListingForm />
        </div>
      </main>
    </RoleGuard>
  );
}
