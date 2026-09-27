import type { EmailTemplateMessages } from './types.js';

const pt: EmailTemplateMessages = {
  booking_created: (d) => ({
    subject:   `Reserva recebida — ${d.propertyTitle}`,
    preheader: `Sua reserva em ${d.propertyTitle} está pendente de confirmação.`,
    body: `Olá ${d.userName},\n\nSua reserva em "${d.propertyTitle}" foi recebida e está aguardando confirmação do anfitrião.\n\nCheck-in: ${d.checkIn}\nCheck-out: ${d.checkOut}\nTotal: ${d.totalPrice.toFixed(2)} USDC\nID da reserva: ${d.bookingId}\n\nVocê receberá outro e-mail quando o anfitrião confirmar sua estadia.`,
  }),

  booking_confirmed: (d) => ({
    subject:   `Reserva confirmada — ${d.propertyTitle}`,
    preheader: `Sua estadia em ${d.propertyTitle} está confirmada!`,
    body: `Olá ${d.userName},\n\nÓtima notícia — sua reserva em "${d.propertyTitle}" foi confirmada pelo anfitrião!\n\nCheck-in: ${d.checkIn}${d.checkInTime ? ` às ${d.checkInTime}` : ''}\nCheck-out: ${d.checkOut}\nTotal: ${d.totalPrice.toFixed(2)} USDC\nID da reserva: ${d.bookingId}\n\nBoa viagem e aproveite sua estadia!`,
  }),

  booking_cancelled: (d) => ({
    subject:   `Reserva cancelada — ${d.propertyTitle}`,
    preheader: `Sua reserva em ${d.propertyTitle} foi cancelada.`,
    body: `Olá ${d.userName},\n\nSua reserva em "${d.propertyTitle}" foi cancelada.\n\nCheck-in: ${d.checkIn}\nCheck-out: ${d.checkOut}\nTotal: ${d.totalPrice.toFixed(2)} USDC\nID da reserva: ${d.bookingId}\n\nSe você não solicitou este cancelamento ou tiver dúvidas, entre em contato com o suporte.`,
  }),

  payment_received: (d) => ({
    subject:   `Pagamento recebido — ${d.propertyTitle}`,
    preheader: `Você recebeu ${d.amount.toFixed(2)} USDC por ${d.propertyTitle}.`,
    body: `Olá ${d.userName},\n\nVocê recebeu um pagamento de ${d.amount.toFixed(2)} USDC por "${d.propertyTitle}".\n\nID da reserva: ${d.bookingId}\n\nOs fundos foram liberados do depósito em garantia para sua carteira Stellar.`,
  }),

  booking_reminder: (d) => ({
    subject:   `Lembrete: check-in em ${d.daysUntil} dia${d.daysUntil === 1 ? '' : 's'} — ${d.propertyTitle}`,
    preheader: `Sua estadia em ${d.propertyTitle} começa em ${d.daysUntil} dia${d.daysUntil === 1 ? '' : 's'}.`,
    body: `Olá ${d.userName},\n\nEste é um lembrete de que sua estadia em "${d.propertyTitle}" começa em ${d.daysUntil} dia${d.daysUntil === 1 ? '' : 's'}.\n\nCheck-in: ${d.checkIn}\n\nEsperamos que você tenha uma estadia maravilhosa!`,
  }),

  review_requested: (d) => ({
    subject:   `Como foi sua estadia em ${d.propertyTitle}?`,
    preheader: `Compartilhe sua experiência em ${d.propertyTitle}.`,
    body: `Olá ${d.userName},\n\nSua estadia em "${d.propertyTitle}" foi concluída. Adoraríamos saber sobre sua experiência!\n\nID da reserva: ${d.bookingId}\n\nDeixe sua avaliação para ajudar futuros hóspedes.`,
  }),

  review_submitted: (d) => ({
    subject:   `Nova avaliação para ${d.propertyTitle}`,
    preheader: `${d.reviewerName} deixou uma avaliação de ${d.rating} estrelas para ${d.propertyTitle}.`,
    body: `Olá ${d.hostName},\n\n${d.reviewerName} enviou uma avaliação de ${d.rating} estrela${d.rating === 1 ? '' : 's'} para "${d.propertyTitle}".\n\nAcesse seu painel para ler e responder à avaliação.`,
  }),

  dispute_initiated: (d) => ({
    subject:   `Disputa iniciada — Reserva ${d.bookingId}`,
    preheader: `Uma disputa foi aberta para sua reserva em ${d.propertyTitle}.`,
    body: `Olá ${d.userName},\n\nUma disputa foi iniciada para sua reserva em "${d.propertyTitle}" (ID: ${d.bookingId}).\n\nAcesse seu painel para revisar os detalhes e responder. Nossa equipe de suporte entrará em contato em breve.`,
  }),

  message_received: (d) => ({
    subject:   `Nova mensagem de ${d.senderName}`,
    preheader: `${d.senderName} enviou uma mensagem para você no Rentars.`,
    body: `Olá ${d.recipientName},\n\n${d.senderName} enviou uma mensagem para você no Rentars.\n\nAcesse seu painel para ler e responder.`,
  }),

  system_alert: (d) => ({
    subject:   'Aviso do sistema Rentars',
    preheader: 'Um aviso importante do Rentars.',
    body: `Olá ${d.userName},\n\n${d.message}`,
  }),
};

export default pt;
