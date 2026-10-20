export type ReconciliationState =
  | 'none'
  | 'pending'
  | 'retrying'
  | 'failed'
  | 'manual_review'
  | 'resolved';

export type RefundState =
  | 'none'
  | 'requested'
  | 'submitted'
  | 'confirmed'
  | 'failed'
  | 'manual_review';

export interface FormattedBooking {
  id: string;
  propertyTitle: string;
  location: string;
  checkIn: Date;
  checkOut: Date;
  totalPrice: number;
  status: 'pending' | 'confirmed' | 'completed' | 'cancelled';
  escrowStatus: 'locked' | 'released' | 'refunded';
  reconciliationState: ReconciliationState;
  refundState: RefundState;
}