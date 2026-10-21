-- Enforce single ownership per push endpoint.
--
-- The previous UNIQUE(user_id, endpoint) constraint allowed the same browser
-- endpoint to be registered under multiple user_ids simultaneously (e.g. after
-- an account switch on the same device), so a previous account could keep
-- receiving push notifications meant for the new account. An endpoint must
-- belong to exactly one user at a time.

-- Collapse any pre-existing duplicate endpoints across users, keeping the
-- most recently created row as the owner.
DELETE FROM push_subscriptions a
USING push_subscriptions b
WHERE a.endpoint = b.endpoint
  AND a.id <> b.id
  AND (a.created_at < b.created_at OR (a.created_at = b.created_at AND a.id < b.id));

ALTER TABLE push_subscriptions DROP CONSTRAINT IF EXISTS push_subscriptions_user_id_endpoint_key;

ALTER TABLE push_subscriptions ADD CONSTRAINT push_subscriptions_endpoint_key UNIQUE (endpoint);
