/**
 * Unit tests for message service — sending, conversation listing, read state,
 * default-recipient resolution, and body sanitization.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';

const mockPropertySingle = mock(async () => ({
  data: { id: 'prop-1', owner_id: 'host-1' },
  error: null,
}));
const mockMessageSingle = mock(async () => ({
  data: {
    id: 'msg-1',
    property_id: 'prop-1',
    conversation_id: 'conv-1',
    sender_id: 'tenant-1',
    recipient_id: 'host-1',
    body: 'hi',
    delivery_status: 'queued',
    client_message_id: null,
    attempt_count: 1,
    read_at: null,
    created_at: new Date().toISOString(),
  },
  error: null,
}));

const propertyEq = mock(() => ({ single: mockPropertySingle }));
const propertySelect = mock(() => ({ eq: propertyEq }));

const mockInsert = mock(() => ({ select: () => ({ single: mockMessageSingle }) }));

const orderMock = mock(async () => ({ data: [], error: null }));
const orMock = mock(() => ({ order: orderMock }));
const messageEq = mock(() => ({ or: orMock, maybeSingle: mock(async () => ({ data: null, error: null })), single: mockMessageSingle }));
const messageSelect = mock(() => ({ eq: messageEq }));

const updateEqRecipient = mock(() => ({ select: () => ({ single: mockMessageSingle }) }));
const updateEq = mock(() => ({ eq: updateEqRecipient, select: () => ({ single: mockMessageSingle }) }));
const mockUpdate = mock(() => ({ eq: updateEq }));

const convRow = {
  id: 'conv-1',
  property_id: 'prop-1',
  booking_id: null,
  status: 'open',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  archived_at: null,
  deleted_at: null,
};

const mockSupabase = {
  from: mock((table: string) => {
    if (table === 'properties') return { select: propertySelect };
    if (table === 'conversations') {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: convRow, error: null }),
            neq: async () => ({ data: [convRow], error: null }),
          }),
        }),
        insert: () => ({
          select: () => ({
            single: async () => ({ data: convRow, error: null }),
          }),
        }),
        update: () => ({
          eq: () => ({
            select: () => ({
              maybeSingle: async () => ({ data: convRow, error: null }),
            }),
          }),
        }),
      };
    }
    if (table === 'conversation_members') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { user_id: 'tenant-1', left_at: null },
                error: null,
              }),
            }),
          }),
        }),
        upsert: async () => ({ error: null }),
      };
    }
    return { select: messageSelect, insert: mockInsert, update: mockUpdate };
  }),
};

mock.module('../../src/config/supabase.js', () => ({ supabase: mockSupabase }));
mock.module('../../src/services/notification.service.js', () => ({
  createNotification: mock(async () => ({ success: true, data: {} })),
  shouldSendInApp: mock(async () => true),
}));

const { sendMessage, getConversation, markMessageRead } = await import(
  '../../src/services/message.service.js'
);

describe('message.service', () => {
  beforeEach(() => {
    mockPropertySingle.mockClear();
    mockMessageSingle.mockClear();
    mockInsert.mockClear();
  });

  describe('sendMessage', () => {
    it('defaults the recipient to the property host when none is given', async () => {
      const result = await sendMessage('tenant-1', 'prop-1', 'Is this still available?');
      expect(result.success).toBe(true);
      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          property_id: 'prop-1',
          sender_id: 'tenant-1',
          recipient_id: 'host-1',
          body: 'Is this still available?',
        }),
      );
    });

    it('uses an explicit recipient when given (e.g. a host replying)', async () => {
      // Host membership check returns tenant-1 above; override members for host
      await sendMessage('host-1', 'prop-1', 'Yes, still available.', 'tenant-1');
      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({ sender_id: 'host-1', recipient_id: 'tenant-1' }),
      );
    });

    it('rejects sending a message to yourself', async () => {
      const result = await sendMessage('host-1', 'prop-1', 'hello');
      expect(result.success).toBe(false);
      expect(result.error).toContain('yourself');
    });

    it('returns an error when the property does not exist', async () => {
      mockPropertySingle.mockImplementationOnce(async () => ({ data: null, error: null }));
      const result = await sendMessage('tenant-1', 'missing-prop', 'hello');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Property not found');
    });

    it('rejects an empty message after sanitization', async () => {
      const result = await sendMessage('tenant-1', 'prop-1', '<script></script>');
      expect(result.success).toBe(false);
      expect(result.error).toContain('required');
    });

    it('strips HTML from the message body before storing it (stored XSS prevention)', async () => {
      await sendMessage('tenant-1', 'prop-1', '<img src=x onerror=alert(1)>Hi there');
      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({ body: 'Hi there' }),
      );
    });
  });

  describe('getConversation', () => {
    it('returns an empty conversation when there are no messages', async () => {
      const result = await getConversation('tenant-1', 'host-1', 'prop-1');
      expect(result.success).toBe(true);
      expect(Array.isArray(result.data)).toBe(true);
    });
  });

  describe('markMessageRead', () => {
    it('marks a message as read for its recipient', async () => {
      // Load existing message first
      messageEq.mockImplementationOnce(() => ({
        maybeSingle: async () => ({
          data: {
            id: 'msg-1',
            recipient_id: 'host-1',
            sender_id: 'tenant-1',
            conversation_id: 'conv-1',
            property_id: 'prop-1',
            delivery_status: 'delivered',
          },
          error: null,
        }),
        or: orMock,
        single: mockMessageSingle,
      }));

      const result = await markMessageRead('msg-1', 'host-1');
      expect(result.success).toBe(true);
    });

    it('returns not found when the message does not belong to the caller', async () => {
      messageEq.mockImplementationOnce(() => ({
        maybeSingle: async () => ({ data: null, error: null }),
        or: orMock,
        single: mockMessageSingle,
      }));
      const result = await markMessageRead('msg-1', 'someone-else');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Message not found');
    });
  });
});
