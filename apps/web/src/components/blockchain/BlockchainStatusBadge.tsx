'use client';

import { CheckCircle, Clock, AlertCircle, XCircle, HelpCircle } from 'lucide-react';
import type { BlockchainStatus } from '@/services/blockchain';

interface BlockchainStatusBadgeProps {
  status: BlockchainStatus;
}

export default function BlockchainStatusBadge({ status }: BlockchainStatusBadgeProps) {
  // Guard against a null/undefined status object arriving at runtime.
  if (!status || typeof status !== 'object') {
    return (
      <div className="flex items-center gap-1 px-2 py-1 bg-gray-100 text-gray-500 rounded-full text-xs font-medium">
        <HelpCircle size={12} />
        Unknown
      </div>
    );
  }

  if (status.pending) {
    return (
      <div className="flex items-center gap-1 px-2 py-1 bg-yellow-100 text-yellow-700 rounded-full text-xs font-medium">
        <Clock size={12} />
        Pending
      </div>
    );
  }

  if (status.verified) {
    return (
      <div className="flex items-center gap-1 px-2 py-1 bg-green-100 text-green-700 rounded-full text-xs font-medium">
        <CheckCircle size={12} />
        Verified
      </div>
    );
  }

  if (status.failed) {
    return (
      <div className="flex items-center gap-1 px-2 py-1 bg-red-100 text-red-700 rounded-full text-xs font-medium">
        <XCircle size={12} />
        Failed
      </div>
    );
  }

  // verified is explicitly false — the property has not been submitted for verification.
  if (status.verified === false) {
    return (
      <div className="flex items-center gap-1 px-2 py-1 bg-gray-100 text-gray-600 rounded-full text-xs font-medium">
        <AlertCircle size={12} />
        Unverified
      </div>
    );
  }

  // Fallback for any future or unrecognised status shape where verified is not
  // a boolean false (e.g. undefined, or a new flag combination). Ensures the
  // badge is never blank and clearly communicates an unexpected state.
  return (
    <div className="flex items-center gap-1 px-2 py-1 bg-gray-100 text-gray-500 rounded-full text-xs font-medium">
      <HelpCircle size={12} />
      Unknown
    </div>
  );
}
