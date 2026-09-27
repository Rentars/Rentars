/**
 * #639 / #640 — Message membership authorization and delivery status.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';

const conversations: Record<string, any> = {};
const members: Array<{ conversation_id: string; user_id: string; left_at: string | null }> = [];
const messages: Record<string, any> = {};
let messageSeq = 0;
let conversationSeq = 0;

function resetStore() {
  for (const k of Object.keys(conversations)) delete conversations[k];
  for (const k of Object.keys(messages)) delete messages[k];
  members.length = 0;
  messageSeq = 0;
  conversationSeq = 0;
}

const mockSupabase = {
  from: mock((table: string) => {
    if (table === 'properties') {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({ data: { id: 'prop-1', owner_id: 'host-1' }, error: null }),
          }),
        }),
      };
    }

    if (table === 'conversations') {
      return {
        select: () => ({
          eq: (col: string, val: string) => ({
            maybeSingle: async () => {
              if (col === 'id') {
                return { data: conversations[val] ?? null, error: null };
              }
              if (col === 'booking_id') {
                const found = Object.values(conversations).find((c) => c.booking_id === val);
                return { data: found ?? null, error: null };
              }
              return { data: null, error: null };
            },
            neq: () => ({
              // list by property
              then: undefined,
            }),
            // for .select().eq().neq used in getConversation — return chain ending in array
          }),
          // getConversation path: .select().eq(property).neq(status)
        }),
        insert: (row: any) => ({
          select: () => ({
            single: async () => {
              conversationSeq += 1;
              const id = row.id ?? `conv-${conversationSeq}`;
              const conv = {
                id,
                property_id: row.property_id,
                booking_id: row.booking_id ?? null,
                status: row.status ?? 'open',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                archived_at: null,
                deleted_at: null,
              };
              conversations[id] = conv;
              return { data: conv, error: null };
            },
          }),
        }),
        update: (patch: any) => ({
          eq: (col: string, val: string) => ({
            select: () => ({
              maybeSingle: async () => {
                const target =
                  col === 'booking_id'
                    ? Object.values(conversations).find((c) => c.booking_id === val)
                    : conversations[val];
                if (!target) return { data: null, error: null };
                Object.assign(target, patch);
                return { data: target, error: null };
              },
            }),
          }),
        }),
      };
    }

    if (table === 'conversation_members') {
      return {
        select: () => ({
          eq: (col1: string, val1: string) => ({
            eq: (col2: string, val2: string) => ({
              maybeSingle: async () => {
                const found = members.find(
                  (m) =>
                    m.conversation_id === (col1 === 'conversation_id' ? val1 : val2) &&
                    m.user_id === (col2 === 'user_id' ? val2 : val1),
                );
                return { data: found ?? null, error: null };
              },
            }),
          }),
        }),
        upsert: async (rows: any[]) => {
          for (const row of rows) {
            const idx = members.findIndex(
              (m) => m.conversation_id === row.conversation_id && m.user_id === row.user_id,
            );
            const entry = {
              conversation_id: row.conversation_id,
              user_id: row.user_id,
              left_at: null,
            };
            if (idx >= 0) members[idx] = entry;
            else members.push(entry);
          }
          return { error: null };
        },
      };
    }

    // messages
    return {
      select: () => ({
        eq: (col: string, val: string) => {
          const chain: any = {
            eq: (col2: string, val2: string) => ({
              maybeSingle: async () => {
                const found = Object.values(messages).find(
                  (m) => m[col] === val && m[col2] === val2,
                );
                return { data: found ?? null, error: null };
              },
              single: async () => {
                const found = Object.values(messages).find(
                  (m) => m[col] === val && m[col2] === val2,
                );
                return { data: found ?? null, error: found ? null : { message: 'not found' } };
              },
            }),
            maybeSingle: async () => {
              const found = Object.values(messages).find((m) => m[col] === val);
              return { data: found ?? null, error: null };
            },
            single: async () => {
              const found = Object.values(messages).find((m) => m[col] === val);
              return { data: found ?? null, error: found ? null : { message: 'not found' } };
            },
            or: () => ({
              order: async () => ({
                data: Object.values(messages).filter(
                  (m) =>
                    m.property_id === val ||
                    true,
                ),
                error: null,
              }),
            }),
            order: async () => ({
              data: Object.values(messages).filter((m) => m[col] === val),
              error: null,
            }),
          };
          return chain;
        },
      }),
      insert: (row: any) => ({
        select: () => ({
          single: async () => {
            messageSeq += 1;
            const id = `msg-${messageSeq}`;
            const msg = {
              id,
              conversation_id: row.conversation_id,
              property_id: row.property_id,
              booking_id: row.booking_id ?? null,
              sender_id: row.sender_id,
              recipient_id: row.recipient_id,
              body: row.body,
              read_at: null,
              delivery_status: row.delivery_status ?? 'queued',
              client_message_id: row.client_message_id ?? null,
              attempt_count: row.attempt_count ?? 1,
              delivered_at: null,
              failed_at: null,
              failure_reason: null,
              created_at: new Date().toISOString(),
            };
            // unique client_message_id
            if (row.client_message_id) {
              const dup = Object.values(messages).find(
                (m) =>
                  m.sender_id === row.sender_id && m.client_message_id === row.client_message_id,
              );
              if (dup) {
                return { data: null, error: { message: 'duplicate key value violates unique constraint' } };
              }
            }
            messages[id] = msg;
            return { data: msg, error: null };
          },
        }),
      }),
      update: (patch: any) => ({
        eq: (col: string, val: string) => {
          const apply = (msg: any) => {
            Object.assign(msg, patch);
            return msg;
          };
          const chain: any = {
            eq: (col2: string, val2: string) => ({
              select: () => ({
                single: async () => {
                  const found = Object.values(messages).find(
                    (m) => m[col] === val && m[col2] === val2,
                  );
                  if (!found) return { data: null, error: null };
                  return { data: apply(found), error: null };
                },
              }),
            }),
            select: () => ({
              single: async () => {
                const found = Object.values(messages).find((m) => m[col] === val);
                if (!found) return { data: null, error: null };
                return { data: apply(found), error: null };
              },
            }),
          };
          return chain;
        },
      }),
    };
  }),
};

mock.module('../../src/config/supabase.js', () => ({ supabase: mockSupabase }));
mock.module('../../src/services/notification.service.js', () => ({
  createNotification: mock(async () => ({ success: true, data: {} })),
  shouldSendInApp: mock(async () => true),
}));

const {
  sendMessageWithParams,
  getConversation,
  getConversationById,
  markMessageRead,
  retryMessageDelivery,
  assertConversationMember,
  advanceDeliveryStatus,
  setConversationLifecycle,
  ensureConversation,
} = await import('../../src/services/message.service.js');

describe('message membership (#639)', () => {
  beforeEach(() => {
    resetStore();
    mockSupabase.from.mockClear();
  });

  it('rejects IDOR: stranger cannot read a conversation by id', async () => {
    const ensured = await ensureConversation({
      propertyId: 'prop-1',
      hostId: 'host-1',
      tenantId: 'tenant-1',
    });
    expect(ensured.success).toBe(true);
    const convId = ensured.data!.id;

    const denied = await assertConversationMember(convId, 'attacker-9');
    expect(denied.success).toBe(false);
    expect(denied.error).toContain('Forbidden');

    const list = await getConversationById('attacker-9', convId);
    expect(list.success).toBe(false);
    expect(list.error).toContain('Forbidden');
  });

  it('allows only members to send', async () => {
    const ensured = await ensureConversation({
      propertyId: 'prop-1',
      hostId: 'host-1',
      tenantId: 'tenant-1',
    });
    const convId = ensured.data!.id;

    const attack = await sendMessageWithParams({
      senderId: 'attacker-9',
      propertyId: 'prop-1',
      body: 'pwned',
      recipientId: 'host-1',
      conversationId: convId,
    });
    expect(attack.success).toBe(false);
    expect(attack.error).toMatch(/Forbidden|not a conversation member/);
  });

  it('rejects stranger getConversation via otherUserId swap (IDOR)', async () => {
    const result = await getConversation('attacker-9', 'host-1', 'prop-1');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Forbidden');
  });

  it('archives booking-linked conversations (read-only lifecycle)', async () => {
    await ensureConversation({
      propertyId: 'prop-1',
      hostId: 'host-1',
      tenantId: 'tenant-1',
      bookingId: 'book-1',
    });
    const archived = await setConversationLifecycle('book-1', 'archived');
    expect(archived.success).toBe(true);
    expect(archived.data!.status).toBe('archived');

    const send = await sendMessageWithParams({
      senderId: 'tenant-1',
      propertyId: 'prop-1',
      body: 'still there?',
      conversationId: archived.data!.id,
    });
    expect(send.success).toBe(false);
    expect(send.error).toMatch(/archived|not allowed/);
  });

  it('only the recipient may mark read — cannot forge read status', async () => {
    const ensured = await ensureConversation({
      propertyId: 'prop-1',
      hostId: 'host-1',
      tenantId: 'tenant-1',
    });
    const sent = await sendMessageWithParams({
      senderId: 'tenant-1',
      propertyId: 'prop-1',
      body: 'hello host',
      conversationId: ensured.data!.id,
    });
    expect(sent.success).toBe(true);

    const forged = await markMessageRead(sent.data!.id, 'tenant-1');
    expect(forged.success).toBe(false);
    expect(forged.error).toContain('only the recipient');

    const ok = await markMessageRead(sent.data!.id, 'host-1');
    expect(ok.success).toBe(true);
    expect(ok.data!.delivery_status).toBe('read');
  });
});

describe('message delivery status (#640)', () => {
  beforeEach(() => {
    resetStore();
  });

  it('keeps one stable identity across client retries (clientMessageId)', async () => {
    const first = await sendMessageWithParams({
      senderId: 'tenant-1',
      propertyId: 'prop-1',
      body: 'ping',
      clientMessageId: 'client-abc-1',
    });
    expect(first.success).toBe(true);

    const retry = await sendMessageWithParams({
      senderId: 'tenant-1',
      propertyId: 'prop-1',
      body: 'ping',
      clientMessageId: 'client-abc-1',
    });
    expect(retry.success).toBe(true);
    expect(retry.data!.id).toBe(first.data!.id);
    expect(Object.keys(messages)).toHaveLength(1);
  });

  it('transitions queued → sent → delivered and supports failed retry', async () => {
    const sent = await sendMessageWithParams({
      senderId: 'tenant-1',
      propertyId: 'prop-1',
      body: 'delivery path',
      clientMessageId: 'client-del-1',
    });
    expect(sent.success).toBe(true);
    expect(['sent', 'delivered', 'queued']).toContain(sent.data!.delivery_status);

    // Force failed
    messages[sent.data!.id].delivery_status = 'failed';
    messages[sent.data!.id].failed_at = new Date().toISOString();

    const retried = await retryMessageDelivery(sent.data!.id, 'tenant-1');
    expect(retried.success).toBe(true);
    expect(['queued', 'sent', 'delivered']).toContain(retried.data!.delivery_status);
    expect(retried.data!.attempt_count).toBeGreaterThanOrEqual(2);
  });

  it('rejects delivery retry from non-sender', async () => {
    const sent = await sendMessageWithParams({
      senderId: 'tenant-1',
      propertyId: 'prop-1',
      body: 'x',
    });
    messages[sent.data!.id].delivery_status = 'failed';

    const denied = await retryMessageDelivery(sent.data!.id, 'host-1');
    expect(denied.success).toBe(false);
    expect(denied.error).toContain('only the sender');
  });

  it('rejects invalid delivery transitions', async () => {
    const sent = await sendMessageWithParams({
      senderId: 'tenant-1',
      propertyId: 'prop-1',
      body: 'y',
    });
    // Force delivered then try to go back to queued directly via advance
    messages[sent.data!.id].delivery_status = 'delivered';
    const bad = await advanceDeliveryStatus(sent.data!.id, 'queued');
    expect(bad.success).toBe(false);
    expect(bad.error).toContain('Invalid delivery transition');
  });
});
