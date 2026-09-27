import type { EmailTemplateMessages } from './types.js';

const fr: EmailTemplateMessages = {
  booking_created: (d) => ({
    subject:   `Réservation reçue — ${d.propertyTitle}`,
    preheader: `Votre réservation à ${d.propertyTitle} est en attente de confirmation.`,
    body: `Bonjour ${d.userName},\n\nVotre réservation pour « ${d.propertyTitle} » a bien été reçue et est en attente de confirmation de l'hôte.\n\nArrivée : ${d.checkIn}\nDépart : ${d.checkOut}\nTotal : ${d.totalPrice.toFixed(2)} USDC\nRéférence : ${d.bookingId}\n\nVous recevrez un autre e-mail dès que l'hôte aura confirmé votre séjour.`,
  }),

  booking_confirmed: (d) => ({
    subject:   `Réservation confirmée — ${d.propertyTitle}`,
    preheader: `Votre séjour à ${d.propertyTitle} est confirmé !`,
    body: `Bonjour ${d.userName},\n\nBonne nouvelle — votre réservation pour « ${d.propertyTitle} » a été confirmée par l'hôte !\n\nArrivée : ${d.checkIn}${d.checkInTime ? ` à ${d.checkInTime}` : ''}\nDépart : ${d.checkOut}\nTotal : ${d.totalPrice.toFixed(2)} USDC\nRéférence : ${d.bookingId}\n\nBon voyage et profitez bien de votre séjour.`,
  }),

  booking_cancelled: (d) => ({
    subject:   `Réservation annulée — ${d.propertyTitle}`,
    preheader: `Votre réservation à ${d.propertyTitle} a été annulée.`,
    body: `Bonjour ${d.userName},\n\nVotre réservation pour « ${d.propertyTitle} » a été annulée.\n\nArrivée : ${d.checkIn}\nDépart : ${d.checkOut}\nTotal : ${d.totalPrice.toFixed(2)} USDC\nRéférence : ${d.bookingId}\n\nSi vous n'avez pas demandé cette annulation ou si vous avez des questions, veuillez contacter le support.`,
  }),

  payment_received: (d) => ({
    subject:   `Paiement reçu — ${d.propertyTitle}`,
    preheader: `Vous avez reçu ${d.amount.toFixed(2)} USDC pour ${d.propertyTitle}.`,
    body: `Bonjour ${d.userName},\n\nVous avez reçu un paiement de ${d.amount.toFixed(2)} USDC pour « ${d.propertyTitle} ».\n\nRéférence : ${d.bookingId}\n\nLes fonds ont été libérés du séquestre vers votre portefeuille Stellar.`,
  }),

  booking_reminder: (d) => ({
    subject:   `Rappel : arrivée dans ${d.daysUntil} jour${d.daysUntil === 1 ? '' : 's'} — ${d.propertyTitle}`,
    preheader: `Votre séjour à ${d.propertyTitle} commence dans ${d.daysUntil} jour${d.daysUntil === 1 ? '' : 's'}.`,
    body: `Bonjour ${d.userName},\n\nCeci est un rappel que votre séjour à « ${d.propertyTitle} » commence dans ${d.daysUntil} jour${d.daysUntil === 1 ? '' : 's'}.\n\nArrivée : ${d.checkIn}\n\nNous vous souhaitons un excellent séjour !`,
  }),

  review_requested: (d) => ({
    subject:   `Comment s'est passé votre séjour à ${d.propertyTitle} ?`,
    preheader: `Partagez votre expérience à ${d.propertyTitle}.`,
    body: `Bonjour ${d.userName},\n\nVotre séjour à « ${d.propertyTitle} » est terminé. Nous aimerions connaître votre expérience !\n\nRéférence : ${d.bookingId}\n\nLaissez votre avis pour aider les futurs voyageurs.`,
  }),

  review_submitted: (d) => ({
    subject:   `Nouvel avis pour ${d.propertyTitle}`,
    preheader: `${d.reviewerName} a laissé un avis de ${d.rating} étoiles pour ${d.propertyTitle}.`,
    body: `Bonjour ${d.hostName},\n\n${d.reviewerName} a soumis un avis de ${d.rating} étoile${d.rating === 1 ? '' : 's'} pour « ${d.propertyTitle} ».\n\nConnectez-vous à votre tableau de bord pour lire et répondre à cet avis.`,
  }),

  dispute_initiated: (d) => ({
    subject:   `Litige ouvert — Réservation ${d.bookingId}`,
    preheader: `Un litige a été ouvert pour votre réservation à ${d.propertyTitle}.`,
    body: `Bonjour ${d.userName},\n\nUn litige a été initié pour votre réservation à « ${d.propertyTitle} » (réf. : ${d.bookingId}).\n\nVeuillez vous connecter à votre tableau de bord pour examiner les détails et répondre. Notre équipe de support vous contactera rapidement.`,
  }),

  message_received: (d) => ({
    subject:   `Nouveau message de ${d.senderName}`,
    preheader: `${d.senderName} vous a envoyé un message sur Rentars.`,
    body: `Bonjour ${d.recipientName},\n\n${d.senderName} vous a envoyé un message sur Rentars.\n\nConnectez-vous à votre tableau de bord pour le lire et y répondre.`,
  }),

  system_alert: (d) => ({
    subject:   'Avis système Rentars',
    preheader: 'Un avis important de Rentars.',
    body: `Bonjour ${d.userName},\n\n${d.message}`,
  }),
};

export default fr;
