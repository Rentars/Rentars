-- Migration 00068: Extend notification_preferences for trust workflow types
--
-- Adds columns to distinguish mandatory (operational) notification channels
-- from optional promotional ones, and introduces per-channel overrides
-- for trust-specific notification types.

-- Document the mandatory channel policy in a dedicated column.
-- This is the channel that MUST receive dispute/security notices even when
-- email or push is disabled globally.
-- Values: 'email' | 'in_app' (push cannot be mandatory — requires opt-in)
ALTER TABLE notification_preferences
  ADD COLUMN IF NOT EXISTS mandatory_channel VARCHAR(20) NOT NULL DEFAULT 'in_app';

-- Constraint: mandatory_channel can only be 'email' or 'in_app'.
ALTER TABLE notification_preferences
  DROP CONSTRAINT IF EXISTS chk_mandatory_channel;

ALTER TABLE notification_preferences
  ADD CONSTRAINT chk_mandatory_channel
    CHECK (mandatory_channel IN ('email', 'in_app'));

-- Comments that make the column intent self-documenting.
COMMENT ON COLUMN notification_preferences.mandatory_channel IS
  'Channel that must receive security/dispute notices regardless of other '
  'preference settings. Only "email" or "in_app" are valid — push cannot '
  'be mandatory because it requires a device opt-in.';

COMMENT ON COLUMN notification_preferences.notification_types IS
  'Per-type opt-in/opt-out map.  Keys are NotificationType values.  '
  'Mandatory types (dispute_initiated, account_security_alert, etc.) are '
  'ignored in this map and always delivered via mandatory_channel.';
