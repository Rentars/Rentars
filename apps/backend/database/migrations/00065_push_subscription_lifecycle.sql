-- Issue 074: complete push subscription lifecycle.
--
-- The original table (database/migrations/005_create_push_subscriptions.sql)
-- keys a subscription by (user_id, endpoint). That allows the same browser
-- endpoint to stay attached to an account that has logged out, which is how a
-- previous account keeps receiving pushes on a shared device.
--
-- Changes:
--   1. `endpoint` becomes globally unique, so one browser endpoint belongs to
--      exactly one account at a time. Registering an endpoint again (the same
--      device signing in as somebody else) transfers ownership to the new
--      account instead of creating a second row.
--   2. Lifecycle metadata: when the endpoint was last seen, what the browser
--      reported for its notification permission, the subscription expiry and the
--      registering user agent — so retired devices are explainable and stale
--      rows are collectable.
--   3. RLS: a user can only read or change their own subscriptions.
--   4. A retention index for the cleanup job.

-- ── 1. One row per endpoint ──────────────────────────────────────────────────

-- Ownership transfer must be atomic, so duplicates are resolved before the
-- unique index is created: keep the most recently used row, drop the rest.
DELETE FROM push_subscriptions older
USING push_subscriptions newer
WHERE older.endpoint = newer.endpoint
  AND older.user_id <> newer.user_id
  AND (
    COALESCE(older.updated_at, older.created_at) < COALESCE(newer.updated_at, newer.created_at)
    OR (
      COALESCE(older.updated_at, older.created_at) = COALESCE(newer.updated_at, newer.created_at)
      AND older.id < newer.id
    )
  );

DELETE FROM push_subscriptions duplicate
USING push_subscriptions keeper
WHERE duplicate.endpoint = keeper.endpoint
  AND duplicate.user_id = keeper.user_id
  AND duplicate.id > keeper.id;

ALTER TABLE push_subscriptions DROP CONSTRAINT IF EXISTS push_subscriptions_user_id_endpoint_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_push_subscriptions_endpoint_unique
  ON push_subscriptions(endpoint);

-- ── 2. Lifecycle metadata ────────────────────────────────────────────────────

ALTER TABLE push_subscriptions
  ADD COLUMN IF NOT EXISTS user_agent TEXT,
  ADD COLUMN IF NOT EXISTS permission TEXT,
  ADD COLUMN IF NOT EXISTS expiration_time TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

-- Existing rows predate tracking: their last write is the best estimate of when
-- they were last seen. Defaulting to NOW() would both lie and (worse) exempt
-- abandoned rows from the retention job below.
ALTER TABLE push_subscriptions
  ALTER COLUMN last_seen_at SET DEFAULT NOW();

UPDATE push_subscriptions
SET last_seen_at = COALESCE(updated_at, created_at, NOW())
WHERE last_seen_at IS NULL;

ALTER TABLE push_subscriptions
  ALTER COLUMN last_seen_at SET NOT NULL;

-- Browser permission states, plus NULL for rows registered by older clients.
ALTER TABLE push_subscriptions DROP CONSTRAINT IF EXISTS push_subscriptions_permission_check;
ALTER TABLE push_subscriptions
  ADD CONSTRAINT push_subscriptions_permission_check
  CHECK (permission IS NULL OR permission IN ('granted', 'denied', 'default'));

-- ── 3. Row level security ────────────────────────────────────────────────────

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS push_subscriptions_select_own ON push_subscriptions;
CREATE POLICY push_subscriptions_select_own ON push_subscriptions
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS push_subscriptions_insert_own ON push_subscriptions;
CREATE POLICY push_subscriptions_insert_own ON push_subscriptions
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS push_subscriptions_update_own ON push_subscriptions;
CREATE POLICY push_subscriptions_update_own ON push_subscriptions
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS push_subscriptions_delete_own ON push_subscriptions;
CREATE POLICY push_subscriptions_delete_own ON push_subscriptions
  FOR DELETE USING (auth.uid() = user_id);

-- ── 4. Indexes for the two access paths ──────────────────────────────────────

-- Delivery: every active subscription for one user.
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_last_seen
  ON push_subscriptions(user_id, last_seen_at DESC);

-- Retention: sweep endpoints that have not been seen for a long time.
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_last_seen
  ON push_subscriptions(last_seen_at);

ANALYZE push_subscriptions;
