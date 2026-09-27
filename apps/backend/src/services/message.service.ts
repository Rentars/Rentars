/**
 * Message service — conversation membership (#639) + delivery status (#640).
 *
 * Authorization:
 *   Every read, send, attachment, and mark-read path goes through
 *   assertConversationMember(). Changing a conversation ID cannot expose
 *   another user's messages (IDOR-safe).
 *
 * Lifecycle:
 *   Booking-linked conversations: open → archived (cancel/complete) → deleted.
 *   Archived: read-only. Deleted: hidden from members.
 *
 * Delivery (#640):
 *   queued → sent → delivered → read | failed
 *   client_message_id is unique per sender so retries never create duplicates.
 */

import { supabase } from '../config/supabase.js';
import { sanitizeResponse } from '../utils/sanitize.js';
import { createNotification, shouldSendInApp } from './notification.service.js';
import type { ServiceResponse } from './index.js';

export type ConversationStatus = 'open' | 'archived' | 'deleted';
export type DeliveryStatus = 'queued' | 'sent' | 'delivered' | 'read' | 'failed';

export interface Conversation {
  id: string;
  property_id: string;
  booking_id: string | null;
  status: ConversationStatus;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  deleted_at: string | null;
}

export interface Message {
  id: string;
  conversation_id: string | null;
  property_id: string;
  booking_id: string | null;
  sender_id: string;
  recipient_id: string;
  body: string;
  read_at: string | null;
  delivery_status: DeliveryStatus;
  client_message_id: string | null;
  attempt_count: number;
  delivered_at: string | null;
  failed_at: string | null;
  failure_reason: string | null;
  created_at: string;
}

export interface SendMessageParams {
  senderId: string;
  propertyId: string;
  body: string;
  recipientId?: string;
  conversationId?: string;
  bookingId?: string;
  /** Stable client identity across retries/devices. */
  clientMessageId?: string;
}

const DELIVERY_TRANSITIONS: Readonly<Record<DeliveryStatus, ReadonlyArray<DeliveryStatus>>> = {
  queued: ['sent', 'failed'],
  sent: ['delivered', 'failed'],
  delivered: ['read', 'failed'],
  read: [],
  failed: ['queued', 'sent'], // retry re-queues
};

/** Delivery metrics counters (process-local; scraped alongside payment metrics). */
export const messageDeliveryMetrics = {
  queued: 0,
  sent: 0,
  delivered: 0,
  read: 0,
  failed: 0,
  retries: 0,
  duplicatesSuppressed: 0,
};

function bumpMetric(status: DeliveryStatus | 'retries' | 'duplicatesSuppressed'): void {
  messageDeliveryMetrics[status] += 1;
}

/**
 * Central membership policy. Returns the conversation when the user is an
 * active member and the conversation is not soft-deleted.
 */
export async function assertConversationMember(
  conversationId: string,
  userId: string,
  options: { requireOpen?: boolean } = {},
): Promise<ServiceResponse<Conversation>> {
  const { data: conversation, error } = await supabase
    .from('conversations')
    .select('*')
    .eq('id', conversationId)
    .maybeSingle();

  if (error) return { success: false, error: error.message };
  if (!conversation) return { success: false, error: 'Conversation not found' };

  const conv = conversation as Conversation;

  if (conv.status === 'deleted') {
    return { success: false, error: 'Conversation has been deleted' };
  }

  const { data: membership, error: memberError } = await supabase
    .from('conversation_members')
    .select('user_id, left_at')
    .eq('conversation_id', conversationId)
    .eq('user_id', userId)
    .maybeSingle();

  if (memberError) return { success: false, error: memberError.message };
  if (!membership || membership.left_at) {
    return { success: false, error: 'Forbidden: not a conversation member' };
  }

  if (options.requireOpen && conv.status !== 'open') {
    return {
      success: false,
      error: `Conversation is ${conv.status}; new messages are not allowed`,
    };
  }

  return { success: true, data: conv };
}

/**
 * Resolve or create a property/booking-scoped conversation and ensure both
 * participants are members.
 */
export async function ensureConversation(params: {
  propertyId: string;
  hostId: string;
  tenantId: string;
  bookingId?: string;
}): Promise<ServiceResponse<Conversation>> {
  const { propertyId, hostId, tenantId, bookingId } = params;

  if (bookingId) {
    const { data: existing } = await supabase
      .from('conversations')
      .select('*')
      .eq('booking_id', bookingId)
      .maybeSingle();

    if (existing && (existing as Conversation).status !== 'deleted') {
      return { success: true, data: existing as Conversation };
    }
  }

  const { data: created, error } = await supabase
    .from('conversations')
    .insert({
      property_id: propertyId,
      booking_id: bookingId ?? null,
      status: 'open',
    })
    .select()
    .single();

  if (error || !created) {
    return { success: false, error: error?.message ?? 'Failed to create conversation' };
  }

  const conversation = created as Conversation;
  const members = [
    { conversation_id: conversation.id, user_id: hostId, role: 'host' },
    { conversation_id: conversation.id, user_id: tenantId, role: 'tenant' },
  ];

  const { error: memberError } = await supabase.from('conversation_members').upsert(members, {
    onConflict: 'conversation_id,user_id',
  });

  if (memberError) {
    return { success: false, error: memberError.message };
  }

  return { success: true, data: conversation };
}

/**
 * Archive or soft-delete a booking-linked conversation (lifecycle).
 */
export async function setConversationLifecycle(
  bookingId: string,
  next: 'archived' | 'deleted',
): Promise<ServiceResponse<Conversation>> {
  const patch: Record<string, unknown> = {
    status: next,
    updated_at: new Date().toISOString(),
  };
  if (next === 'archived') patch.archived_at = new Date().toISOString();
  if (next === 'deleted') patch.deleted_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('conversations')
    .update(patch)
    .eq('booking_id', bookingId)
    .select()
    .maybeSingle();

  if (error) return { success: false, error: error.message };
  if (!data) return { success: false, error: 'Conversation not found for booking' };
  return { success: true, data: data as Conversation };
}

/**
 * Send a message. Membership is enforced when conversationId is provided;
 * otherwise a property inquiry conversation is ensured for host+sender.
 */
export async function sendMessage(
  senderId: string,
  propertyId: string,
  body: string,
  recipientId?: string,
  options: {
    conversationId?: string;
    bookingId?: string;
    clientMessageId?: string;
  } = {},
): Promise<ServiceResponse<Message>> {
  return sendMessageWithParams({
    senderId,
    propertyId,
    body,
    recipientId,
    conversationId: options.conversationId,
    bookingId: options.bookingId,
    clientMessageId: options.clientMessageId,
  });
}

export async function sendMessageWithParams(
  params: SendMessageParams,
): Promise<ServiceResponse<Message>> {
  const { senderId, propertyId, body, recipientId, conversationId, bookingId, clientMessageId } =
    params;

  // Dedup: same client_message_id from same sender returns existing row
  if (clientMessageId) {
    const { data: existing } = await supabase
      .from('messages')
      .select('*')
      .eq('sender_id', senderId)
      .eq('client_message_id', clientMessageId)
      .maybeSingle();

    if (existing) {
      bumpMetric('duplicatesSuppressed');
      return { success: true, data: rowToMessage(existing) };
    }
  }

  const { data: property, error: propertyError } = await supabase
    .from('properties')
    .select('id, owner_id')
    .eq('id', propertyId)
    .single();

  if (propertyError || !property) {
    return { success: false, error: 'Property not found' };
  }

  const hostId = (property as { owner_id: string }).owner_id;
  const resolvedRecipientId = recipientId || hostId;

  if (resolvedRecipientId === senderId) {
    return { success: false, error: 'You cannot message yourself' };
  }

  // Only host or the other participant may be addressed on a property thread
  if (resolvedRecipientId !== hostId && senderId !== hostId) {
    // Tenant messaging someone who is not the host — reject
    return { success: false, error: 'Forbidden: recipient is not a conversation participant' };
  }
  if (senderId !== hostId && senderId !== resolvedRecipientId) {
    // redundant guard kept for clarity
  }

  const cleanBody = sanitizeResponse(body);
  if (!cleanBody) {
    return { success: false, error: 'Message body is required' };
  }

  let conversation: Conversation | null = null;

  if (conversationId) {
    const membership = await assertConversationMember(conversationId, senderId, {
      requireOpen: true,
    });
    if (!membership.success || !membership.data) {
      return { success: false, error: membership.error ?? 'Forbidden' };
    }
    conversation = membership.data;

    // Recipient must also be a member
    const recipientMembership = await assertConversationMember(
      conversationId,
      resolvedRecipientId,
    );
    if (!recipientMembership.success) {
      return { success: false, error: 'Forbidden: recipient is not a conversation member' };
    }
  } else {
    const ensured = await ensureConversation({
      propertyId,
      hostId,
      tenantId: senderId === hostId ? resolvedRecipientId : senderId,
      bookingId,
    });
    if (!ensured.success || !ensured.data) {
      return { success: false, error: ensured.error ?? 'Failed to open conversation' };
    }
    conversation = ensured.data;

    const membership = await assertConversationMember(conversation.id, senderId, {
      requireOpen: true,
    });
    if (!membership.success) {
      return { success: false, error: membership.error ?? 'Forbidden' };
    }
  }

  const { data, error } = await supabase
    .from('messages')
    .insert({
      conversation_id: conversation.id,
      property_id: propertyId,
      booking_id: bookingId ?? conversation.booking_id,
      sender_id: senderId,
      recipient_id: resolvedRecipientId,
      body: cleanBody,
      delivery_status: 'queued',
      client_message_id: clientMessageId ?? null,
      attempt_count: 1,
      last_attempt_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) {
    // Unique violation on client_message_id → fetch and return existing
    if (clientMessageId && /duplicate|unique/i.test(error.message)) {
      const { data: dup } = await supabase
        .from('messages')
        .select('*')
        .eq('sender_id', senderId)
        .eq('client_message_id', clientMessageId)
        .maybeSingle();
      if (dup) {
        bumpMetric('duplicatesSuppressed');
        return { success: true, data: rowToMessage(dup) };
      }
    }
    return { success: false, error: error.message };
  }

  let message = rowToMessage(data);
  bumpMetric('queued');

  // Async delivery: mark sent then delivered (in-process; realtime fan-out hooks here)
  const delivered = await advanceDeliveryStatus(message.id, 'sent', senderId);
  if (delivered.success && delivered.data) {
    message = delivered.data;
    const deliveredResult = await advanceDeliveryStatus(message.id, 'delivered', senderId);
    if (deliveredResult.success && deliveredResult.data) {
      message = deliveredResult.data;
    }
  }

  try {
    const send = await shouldSendInApp(resolvedRecipientId, 'message_received');
    if (send) {
      await createNotification(resolvedRecipientId, 'message_received', {
        messageId: message.id,
        propertyId,
        senderId,
        conversationId: conversation.id,
      });
    }
  } catch (err) {
    console.error(`[sendMessage] Failed to notify recipient ${resolvedRecipientId}:`, err);
  }

  return { success: true, data: message };
}

/**
 * List messages in a conversation. Membership required.
 */
export async function getConversationById(
  userId: string,
  conversationId: string,
): Promise<ServiceResponse<Message[]>> {
  const membership = await assertConversationMember(conversationId, userId);
  if (!membership.success) {
    return { success: false, error: membership.error ?? 'Forbidden' };
  }

  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });

  if (error) return { success: false, error: error.message };
  return { success: true, data: (data ?? []).map(rowToMessage) };
}

/**
 * Legacy property-scoped conversation listing — still membership-gated via
 * host/participant check so IDOR by swapping otherUserId fails for strangers.
 */
export async function getConversation(
  userId: string,
  otherUserId: string,
  propertyId: string,
): Promise<ServiceResponse<Message[]>> {
  const { data: property, error: propertyError } = await supabase
    .from('properties')
    .select('id, owner_id')
    .eq('id', propertyId)
    .single();

  if (propertyError || !property) {
    return { success: false, error: 'Property not found' };
  }

  const hostId = (property as { owner_id: string }).owner_id;
  const participants = new Set([hostId, otherUserId, userId]);

  // Caller must be host or the other participant; stranger IDOR rejected
  if (userId !== hostId && userId !== otherUserId) {
    return { success: false, error: 'Forbidden: not a conversation member' };
  }
  if (otherUserId !== hostId && userId !== hostId && otherUserId !== userId) {
    return { success: false, error: 'Forbidden: not a conversation member' };
  }
  // Other party must be the host or (when caller is host) any prior participant
  if (userId === hostId) {
    // host reading thread with otherUserId — ok
  } else if (otherUserId !== hostId) {
    return { success: false, error: 'Forbidden: not a conversation member' };
  }

  // Prefer conversation_members when a conversation exists for this property pair
  const { data: convs } = await supabase
    .from('conversations')
    .select('id, status')
    .eq('property_id', propertyId)
    .neq('status', 'deleted');

  if (convs && convs.length > 0) {
    for (const conv of convs) {
      const memberCheck = await assertConversationMember(conv.id, userId);
      if (!memberCheck.success) continue;

      const otherCheck = await assertConversationMember(conv.id, otherUserId);
      if (!otherCheck.success) continue;

      return getConversationById(userId, conv.id);
    }
  }

  // Fallback: direct message query with participant filter (legacy rows)
  void participants;
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('property_id', propertyId)
    .or(
      `and(sender_id.eq.${userId},recipient_id.eq.${otherUserId}),and(sender_id.eq.${otherUserId},recipient_id.eq.${userId})`,
    )
    .order('created_at', { ascending: true });

  if (error) return { success: false, error: error.message };
  return { success: true, data: (data ?? []).map(rowToMessage) };
}

/**
 * Mark a message read. Only the recipient (and conversation member) may do so.
 * Read status cannot be forged by another user.
 */
export async function markMessageRead(
  messageId: string,
  userId: string,
): Promise<ServiceResponse<Message>> {
  const { data: existing, error: loadError } = await supabase
    .from('messages')
    .select('*')
    .eq('id', messageId)
    .maybeSingle();

  if (loadError) return { success: false, error: loadError.message };
  if (!existing) return { success: false, error: 'Message not found' };

  const message = rowToMessage(existing);

  if (message.recipient_id !== userId) {
    return { success: false, error: 'Forbidden: only the recipient may mark a message read' };
  }

  if (message.conversation_id) {
    const membership = await assertConversationMember(message.conversation_id, userId);
    if (!membership.success) {
      return { success: false, error: membership.error ?? 'Forbidden' };
    }
  }

  const { data, error } = await supabase
    .from('messages')
    .update({
      read_at: new Date().toISOString(),
      delivery_status: 'read',
    })
    .eq('id', messageId)
    .eq('recipient_id', userId)
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  if (!data) return { success: false, error: 'Message not found' };

  bumpMetric('read');
  return { success: true, data: rowToMessage(data) };
}

/**
 * Advance delivery status with transition checks.
 */
export async function advanceDeliveryStatus(
  messageId: string,
  to: DeliveryStatus,
  actorId?: string,
): Promise<ServiceResponse<Message>> {
  const { data: existing, error: loadError } = await supabase
    .from('messages')
    .select('*')
    .eq('id', messageId)
    .maybeSingle();

  if (loadError) return { success: false, error: loadError.message };
  if (!existing) return { success: false, error: 'Message not found' };

  const current = rowToMessage(existing);
  const allowed = DELIVERY_TRANSITIONS[current.delivery_status] ?? [];
  if (!allowed.includes(to)) {
    return {
      success: false,
      error: `Invalid delivery transition: ${current.delivery_status} → ${to}`,
    };
  }

  if (actorId && current.conversation_id) {
    const membership = await assertConversationMember(current.conversation_id, actorId);
    if (!membership.success && actorId !== current.sender_id) {
      return { success: false, error: 'Forbidden' };
    }
  }

  const patch: Record<string, unknown> = {
    delivery_status: to,
    last_attempt_at: new Date().toISOString(),
  };
  if (to === 'delivered') patch.delivered_at = new Date().toISOString();
  if (to === 'failed') {
    patch.failed_at = new Date().toISOString();
    patch.failure_reason = patch.failure_reason ?? 'delivery_failed';
  }
  if (to === 'read') patch.read_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('messages')
    .update(patch)
    .eq('id', messageId)
    .select()
    .single();

  if (error || !data) return { success: false, error: error?.message ?? 'Update failed' };
  bumpMetric(to);
  return { success: true, data: rowToMessage(data) };
}

/**
 * Client retry for a failed message. Reuses client_message_id — never creates
 * a duplicate visible message.
 */
export async function retryMessageDelivery(
  messageId: string,
  userId: string,
): Promise<ServiceResponse<Message>> {
  const { data: existing, error: loadError } = await supabase
    .from('messages')
    .select('*')
    .eq('id', messageId)
    .maybeSingle();

  if (loadError) return { success: false, error: loadError.message };
  if (!existing) return { success: false, error: 'Message not found' };

  const message = rowToMessage(existing);

  if (message.sender_id !== userId) {
    return { success: false, error: 'Forbidden: only the sender may retry delivery' };
  }

  if (message.conversation_id) {
    const membership = await assertConversationMember(message.conversation_id, userId, {
      requireOpen: true,
    });
    if (!membership.success) {
      return { success: false, error: membership.error ?? 'Forbidden' };
    }
  }

  if (message.delivery_status !== 'failed') {
    // Idempotent: already delivered/sent — return as-is
    if (['sent', 'delivered', 'read'].includes(message.delivery_status)) {
      return { success: true, data: message };
    }
    return { success: false, error: `Cannot retry message in status ${message.delivery_status}` };
  }

  bumpMetric('retries');

  const { data: reset, error: resetError } = await supabase
    .from('messages')
    .update({
      delivery_status: 'queued',
      attempt_count: message.attempt_count + 1,
      last_attempt_at: new Date().toISOString(),
      failure_reason: null,
      failed_at: null,
    })
    .eq('id', messageId)
    .eq('sender_id', userId)
    .select()
    .single();

  if (resetError || !reset) {
    return { success: false, error: resetError?.message ?? 'Retry failed' };
  }

  let updated = rowToMessage(reset);
  bumpMetric('queued');

  const sent = await advanceDeliveryStatus(updated.id, 'sent', userId);
  if (sent.success && sent.data) {
    updated = sent.data;
    const delivered = await advanceDeliveryStatus(updated.id, 'delivered', userId);
    if (delivered.success && delivered.data) updated = delivered.data;
  }

  return { success: true, data: updated };
}

/**
 * Attachment authorization stub — membership required before any upload
 * is associated with a conversation.
 */
export async function assertCanAttach(
  conversationId: string,
  userId: string,
): Promise<ServiceResponse<Conversation>> {
  return assertConversationMember(conversationId, userId, { requireOpen: true });
}

// biome-ignore lint/suspicious/noExplicitAny: raw Supabase row
function rowToMessage(row: any): Message {
  return {
    id: row.id,
    conversation_id: row.conversation_id ?? null,
    property_id: row.property_id,
    booking_id: row.booking_id ?? null,
    sender_id: row.sender_id,
    recipient_id: row.recipient_id,
    body: row.body,
    read_at: row.read_at ?? null,
    delivery_status: (row.delivery_status ?? 'delivered') as DeliveryStatus,
    client_message_id: row.client_message_id ?? null,
    attempt_count: row.attempt_count ?? 1,
    delivered_at: row.delivered_at ?? null,
    failed_at: row.failed_at ?? null,
    failure_reason: row.failure_reason ?? null,
    created_at: row.created_at,
  };
}
