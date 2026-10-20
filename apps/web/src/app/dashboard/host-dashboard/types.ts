export interface HostProperty {
  id: string;
  title: string;
  location: string;
  pricePerNight: number;
  bookings: number;
  rating: number;
  image: string;
}

export interface Transaction {
  id: string;
  type: string;
  amount: number;
  date: Date;
  description: string;
}

export interface PayoutRecord {
  id: string;
  amount: number;
  date: Date;
  status: 'pending' | 'completed' | 'failed';
  method: string;
}

export interface MonthlyMetric {
  month: string;
  earnings: number;
  bookings: number;
}

export interface OccupancyData {
  bookedNights: number;
  availableNights: number;
}

export type LedgerEntryType =
  | 'booking_credit'
  | 'fee_debit'
  | 'release_credit'
  | 'refund_debit'
  | 'adjustment_credit'
  | 'adjustment_debit';

export interface EarningsLedgerEntry {
  id: string;
  entryType: LedgerEntryType;
  amountMinor: number;
  currency: string;
  sourceRef: string;
  createdAt: Date;
}

export interface ReconciliationSummary {
  lastCheckedAt: Date | null;
  discrepancyCount: number;
}

export interface EarningsPayload {
  entries: EarningsLedgerEntry[];
  balanceMinor: number;
  currency: string;
  periodStart: Date | null;
  periodEnd: Date | null;
  reconciliation: ReconciliationSummary;
}