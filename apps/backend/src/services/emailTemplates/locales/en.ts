import type { EmailTemplateMessages } from './types.js';

const en: EmailTemplateMessages = {
  booking_created: (d) => ({
    subject:   `Booking Received — ${d.propertyTitle}`,
    preheader: `Your booking at ${d.propertyTitle} is pending confirmation.`,
    body: `Hi ${d.userName},\n\nYour booking for "${d.propertyTitle}" has been received and is pending confirmation from the host.\n\nCheck-in: ${d.checkIn}\nCheck-out: ${d.checkOut}\nTotal: ${d.totalPrice.toFixed(2)} USDC\nBooking ID: ${d.bookingId}\n\nYou'll receive another email once the host confirms your stay.`,
  }),

  booking_confirmed: (d) => ({
    subject:   `Booking Confirmed — ${d.propertyTitle}`,
    preheader: `Your stay at ${d.propertyTitle} is confirmed!`,
    body: `Hi ${d.userName},\n\nGreat news — your booking for "${d.propertyTitle}" has been confirmed by the host!\n\nCheck-in: ${d.checkIn}${d.checkInTime ? ` at ${d.checkInTime}` : ''}\nCheck-out: ${d.checkOut}\nTotal: ${d.totalPrice.toFixed(2)} USDC\nBooking ID: ${d.bookingId}\n\nSafe travels, and enjoy your stay.`,
  }),

  booking_cancelled: (d) => ({
    subject:   `Booking Cancelled — ${d.propertyTitle}`,
    preheader: `Your booking at ${d.propertyTitle} has been cancelled.`,
    body: `Hi ${d.userName},\n\nYour booking for "${d.propertyTitle}" has been cancelled.\n\nCheck-in: ${d.checkIn}\nCheck-out: ${d.checkOut}\nTotal: ${d.totalPrice.toFixed(2)} USDC\nBooking ID: ${d.bookingId}\n\nIf you did not request this cancellation or have questions, please contact support.`,
  }),

  payment_received: (d) => ({
    subject:   `Payment Received — ${d.propertyTitle}`,
    preheader: `You have received ${d.amount.toFixed(2)} USDC for ${d.propertyTitle}.`,
    body: `Hi ${d.userName},\n\nYou have received a payment of ${d.amount.toFixed(2)} USDC for "${d.propertyTitle}".\n\nBooking ID: ${d.bookingId}\n\nThe funds have been released from escrow to your Stellar wallet.`,
  }),

  booking_reminder: (d) => ({
    subject:   `Reminder: Check-in in ${d.daysUntil} day${d.daysUntil === 1 ? '' : 's'} — ${d.propertyTitle}`,
    preheader: `Your stay at ${d.propertyTitle} starts in ${d.daysUntil} day${d.daysUntil === 1 ? '' : 's'}.`,
    body: `Hi ${d.userName},\n\nThis is a reminder that your stay at "${d.propertyTitle}" begins in ${d.daysUntil} day${d.daysUntil === 1 ? '' : 's'}.\n\nCheck-in: ${d.checkIn}\n\nWe hope you have a wonderful stay!`,
  }),

  review_requested: (d) => ({
    subject:   `How was your stay at ${d.propertyTitle}?`,
    preheader: `Share your experience at ${d.propertyTitle}.`,
    body: `Hi ${d.userName},\n\nYour stay at "${d.propertyTitle}" is complete. We would love to hear about your experience!\n\nBooking ID: ${d.bookingId}\n\nLeave your review to help future guests.`,
  }),

  review_submitted: (d) => ({
    subject:   `New Review for ${d.propertyTitle}`,
    preheader: `${d.reviewerName} left a ${d.rating}-star review for ${d.propertyTitle}.`,
    body: `Hi ${d.hostName},\n\n${d.reviewerName} has submitted a ${d.rating}-star review for "${d.propertyTitle}".\n\nLog in to your dashboard to read and respond to the review.`,
  }),

  dispute_initiated: (d) => ({
    subject:   `Dispute Initiated — Booking ${d.bookingId}`,
    preheader: `A dispute has been opened for your booking at ${d.propertyTitle}.`,
    body: `Hi ${d.userName},\n\nA dispute has been initiated for your booking at "${d.propertyTitle}" (ID: ${d.bookingId}).\n\nPlease log in to your dashboard to review the details and respond. Our support team will be in touch shortly.`,
  }),

  message_received: (d) => ({
    subject:   `New message from ${d.senderName}`,
    preheader: `${d.senderName} sent you a message on Rentars.`,
    body: `Hi ${d.recipientName},\n\n${d.senderName} has sent you a message on Rentars.\n\nLog in to your dashboard to read and reply.`,
  }),

  system_alert: (d) => ({
    subject:   'Rentars System Notice',
    preheader: 'An important notice from Rentars.',
    body: `Hi ${d.userName},\n\n${d.message}`,
  }),
};

export default en;
