/**
 * Shared types for the email template i18n system.
 */

/** Supported locale codes — must match the frontend SUPPORTED_LOCALES. */
export type Locale = 'en' | 'es' | 'fr' | 'pt';

// ─── Data shapes passed to each template function ────────────────────────────

export interface BookingCreatedData {
  userName: string;
  propertyTitle: string;
  checkIn: string;
  checkOut: string;
  totalPrice: number;
  bookingId: string;
}

export interface BookingConfirmedData {
  userName: string;
  propertyTitle: string;
  checkIn: string;
  checkOut: string;
  totalPrice: number;
  bookingId: string;
  /** Optional check-in time e.g. "15:00" */
  checkInTime?: string;
}

export interface BookingCancelledData {
  userName: string;
  propertyTitle: string;
  checkIn: string;
  checkOut: string;
  totalPrice: number;
  bookingId: string;
}

export interface PaymentReceivedData {
  userName: string;
  propertyTitle: string;
  amount: number;
  bookingId: string;
}

export interface BookingReminderData {
  userName: string;
  propertyTitle: string;
  checkIn: string;
  /** Number of days until check-in */
  daysUntil: number;
}

export interface ReviewRequestedData {
  userName: string;
  propertyTitle: string;
  bookingId: string;
}

export interface ReviewSubmittedData {
  hostName: string;
  propertyTitle: string;
  reviewerName: string;
  rating: number;
}

export interface DisputeInitiatedData {
  userName: string;
  propertyTitle: string;
  bookingId: string;
}

export interface MessageReceivedData {
  recipientName: string;
  senderName: string;
}

export interface SystemAlertData {
  userName: string;
  message: string;
}

// ─── Template output ──────────────────────────────────────────────────────────

export interface TemplateOutput {
  /** Email subject line */
  subject: string;
  /** Short preview sentence for email clients */
  preheader: string;
  /** Main HTML body content — do NOT include <html>/<body> wrappers.
   *  Strings here are plain text; escapeHtml() is applied by emailLayout.ts. */
  body: string;
}

// ─── Union type used by callers ───────────────────────────────────────────────

export type TemplateData =
  | BookingCreatedData
  | BookingConfirmedData
  | BookingCancelledData
  | PaymentReceivedData
  | BookingReminderData
  | ReviewRequestedData
  | ReviewSubmittedData
  | DisputeInitiatedData
  | MessageReceivedData
  | SystemAlertData;

// ─── Messages shape (one function per template) ───────────────────────────────

export interface EmailTemplateMessages {
  booking_created:   (d: BookingCreatedData)   => TemplateOutput;
  booking_confirmed: (d: BookingConfirmedData) => TemplateOutput;
  booking_cancelled: (d: BookingCancelledData) => TemplateOutput;
  payment_received:  (d: PaymentReceivedData)  => TemplateOutput;
  booking_reminder:  (d: BookingReminderData)  => TemplateOutput;
  review_requested:  (d: ReviewRequestedData)  => TemplateOutput;
  review_submitted:  (d: ReviewSubmittedData)  => TemplateOutput;
  dispute_initiated: (d: DisputeInitiatedData) => TemplateOutput;
  message_received:  (d: MessageReceivedData)  => TemplateOutput;
  system_alert:      (d: SystemAlertData)      => TemplateOutput;
}
