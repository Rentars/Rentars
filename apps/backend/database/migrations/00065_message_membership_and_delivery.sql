-- #639 / #640 (Issues 071 / 072): Conversation membership + message delivery status.
--
-- Membership:
--   Conversations are first-class entities with explicit members. Booking-linked
--   conversations carry lifecycle state (open / archived / deleted) so cancelled
--   or deleted bookings do not remain writable.
--
-- Delivery (#640):
--   Messages track delivery_status, client_message_id (stable across retries),
--   attempt_count, and delivered_at. Unique (sender_id, client_message_id)
--   prevents duplicate visible messages on client retry.

-- ── Conversations ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  booking_id UUID REFERENCES bookings(id) ON DELETE SET NULL,
  -- open: members may send/read
  -- archived: read-only (booking cancelled/completed retention window)
  -- deleted: hidden from members (soft-delete; rows retained for audit)
  status VARCHAR(20) NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'archived', 'deleted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_conversations_property_id ON conversations(property_id);
CREATE INDEX IF NOT EXISTS idx_conversations_booking_id ON conversations(booking_id)
  WHERE booking_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_booking_unique
  ON conversations(booking_id) WHERE booking_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL DEFAULT 'participant'
    CHECK (role IN ('participant', 'host', 'tenant', 'support')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  left_at TIMESTAMPTZ,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_conversation_members_user
  ON conversation_members(user_id)
  WHERE left_at IS NULL;

-- ── Messages: membership + delivery columns ───────────────────────────────────

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS booking_id UUID REFERENCES bookings(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS delivery_status VARCHAR(20) NOT NULL DEFAULT 'queued'
    CHECK (delivery_status IN ('queued', 'sent', 'delivered', 'read', 'failed')),
  ADD COLUMN IF NOT EXISTS client_message_id VARCHAR(128),
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failure_reason TEXT,
  ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_messages_conversation_id
  ON messages(conversation_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_message_id
  ON messages(sender_id, client_message_id)
  WHERE client_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_delivery_status
  ON messages(delivery_status)
  WHERE delivery_status IN ('queued', 'failed');

COMMENT ON TABLE conversations IS
  '#639 conversation container; membership enforced before every read/send/mark-read';
COMMENT ON TABLE conversation_members IS
  '#639 only listed members may access the conversation; left_at soft-removes access';
COMMENT ON COLUMN messages.delivery_status IS
  '#640 queued → sent → delivered → read; failed is retryable by the sender';
COMMENT ON COLUMN messages.client_message_id IS
  '#640 stable client identity across retries and devices; unique per sender';
