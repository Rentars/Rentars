import type { EmailTemplateMessages } from './types.js';

const es: EmailTemplateMessages = {
  booking_created: (d) => ({
    subject:   `Reserva recibida — ${d.propertyTitle}`,
    preheader: `Tu reserva en ${d.propertyTitle} está pendiente de confirmación.`,
    body: `Hola ${d.userName},\n\nTu reserva en "${d.propertyTitle}" ha sido recibida y está pendiente de confirmación por parte del anfitrión.\n\nEntrada: ${d.checkIn}\nSalida: ${d.checkOut}\nTotal: ${d.totalPrice.toFixed(2)} USDC\nID de reserva: ${d.bookingId}\n\nRecibirás otro correo una vez que el anfitrión confirme tu estadía.`,
  }),

  booking_confirmed: (d) => ({
    subject:   `Reserva confirmada — ${d.propertyTitle}`,
    preheader: `¡Tu estadía en ${d.propertyTitle} está confirmada!`,
    body: `Hola ${d.userName},\n\n¡Buenas noticias! Tu reserva en "${d.propertyTitle}" ha sido confirmada por el anfitrión.\n\nEntrada: ${d.checkIn}${d.checkInTime ? ` a las ${d.checkInTime}` : ''}\nSalida: ${d.checkOut}\nTotal: ${d.totalPrice.toFixed(2)} USDC\nID de reserva: ${d.bookingId}\n\n¡Buen viaje y que disfrutes tu estadía!`,
  }),

  booking_cancelled: (d) => ({
    subject:   `Reserva cancelada — ${d.propertyTitle}`,
    preheader: `Tu reserva en ${d.propertyTitle} ha sido cancelada.`,
    body: `Hola ${d.userName},\n\nTu reserva en "${d.propertyTitle}" ha sido cancelada.\n\nEntrada: ${d.checkIn}\nSalida: ${d.checkOut}\nTotal: ${d.totalPrice.toFixed(2)} USDC\nID de reserva: ${d.bookingId}\n\nSi no solicitaste esta cancelación o tienes preguntas, por favor contacta al soporte.`,
  }),

  payment_received: (d) => ({
    subject:   `Pago recibido — ${d.propertyTitle}`,
    preheader: `Has recibido ${d.amount.toFixed(2)} USDC por ${d.propertyTitle}.`,
    body: `Hola ${d.userName},\n\nHas recibido un pago de ${d.amount.toFixed(2)} USDC por "${d.propertyTitle}".\n\nID de reserva: ${d.bookingId}\n\nLos fondos han sido liberados del depósito en garantía a tu billetera Stellar.`,
  }),

  booking_reminder: (d) => ({
    subject:   `Recordatorio: entrada en ${d.daysUntil} día${d.daysUntil === 1 ? '' : 's'} — ${d.propertyTitle}`,
    preheader: `Tu estadía en ${d.propertyTitle} comienza en ${d.daysUntil} día${d.daysUntil === 1 ? '' : 's'}.`,
    body: `Hola ${d.userName},\n\nEste es un recordatorio de que tu estadía en "${d.propertyTitle}" comienza en ${d.daysUntil} día${d.daysUntil === 1 ? '' : 's'}.\n\nEntrada: ${d.checkIn}\n\n¡Esperamos que tengas una estadía maravillosa!`,
  }),

  review_requested: (d) => ({
    subject:   `¿Cómo fue tu estadía en ${d.propertyTitle}?`,
    preheader: `Comparte tu experiencia en ${d.propertyTitle}.`,
    body: `Hola ${d.userName},\n\nTu estadía en "${d.propertyTitle}" ha concluido. ¡Nos encantaría conocer tu experiencia!\n\nID de reserva: ${d.bookingId}\n\nDeja tu reseña para ayudar a futuros huéspedes.`,
  }),

  review_submitted: (d) => ({
    subject:   `Nueva reseña para ${d.propertyTitle}`,
    preheader: `${d.reviewerName} dejó una reseña de ${d.rating} estrellas para ${d.propertyTitle}.`,
    body: `Hola ${d.hostName},\n\n${d.reviewerName} ha enviado una reseña de ${d.rating} estrellas para "${d.propertyTitle}".\n\nInicia sesión en tu panel para leer y responder la reseña.`,
  }),

  dispute_initiated: (d) => ({
    subject:   `Disputa iniciada — Reserva ${d.bookingId}`,
    preheader: `Se ha abierto una disputa para tu reserva en ${d.propertyTitle}.`,
    body: `Hola ${d.userName},\n\nSe ha iniciado una disputa para tu reserva en "${d.propertyTitle}" (ID: ${d.bookingId}).\n\nPor favor inicia sesión en tu panel para revisar los detalles y responder. Nuestro equipo de soporte se pondrá en contacto contigo en breve.`,
  }),

  message_received: (d) => ({
    subject:   `Nuevo mensaje de ${d.senderName}`,
    preheader: `${d.senderName} te ha enviado un mensaje en Rentars.`,
    body: `Hola ${d.recipientName},\n\n${d.senderName} te ha enviado un mensaje en Rentars.\n\nInicia sesión en tu panel para leer y responder.`,
  }),

  system_alert: (d) => ({
    subject:   'Aviso del sistema Rentars',
    preheader: 'Un aviso importante de Rentars.',
    body: `Hola ${d.userName},\n\n${d.message}`,
  }),
};

export default es;
