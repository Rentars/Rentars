-- Migration: 00065_rls_coverage_all_tables.sql
-- Issue #664 — Review Row Level Security coverage
--
-- Enables RLS and adds participant-scoped policies for every sensitive table
-- that was previously unprotected or had incomplete policy coverage.
--
-- Policy decision summary:
--   • Service-role always bypasses RLS — that is Supabase's standard behaviour.
--     No explicit service_role policy is needed; it is the default escape hatch
--     for all backend writes (booking system, workers, schedulers).
--   • "Authenticated" means auth.role() = 'authenticated' unless otherwise noted.
--   • Admin / moderator roles (host, admin, moderator, support, finance) are
--     handled at the application layer for complex role checks; the DB policies
--     here enforce the baseline ownership invariants.
--
-- Tables addressed:
--   1.  reviews              — reviewer writes, public reads
--   2.  wallet_challenges    — service-only (no direct client access)
--   3.  idempotency_keys     — own-user only
--   4.  messages             — sender + recipient only
--   5.  blockchain_logs      — service-only append-only audit
--   6.  reports              — reporter reads own, admins/service read all
--   7.  booking_modifications — tenant + property-owner read; tenant initiates
--   8.  search_analytics     — service insert; own-user read own rows
--   9.  host_follows         — already has RLS in 00023 (guard: idempotent)
--  10.  property_images      — already has RLS in 00012 (guard: idempotent)
--  11.  audit_logs           — already has RLS in 00028 (guard: idempotent)
--  12.  payments             — already has RLS in 00028 (guard: idempotent)
-- ─────────────────────────────────────────────────────────────────────────────


-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. reviews
-- ═══════════════════════════════════════════════════════════════════════════════
-- Ownership: reviewer_id wrote the review; target_id received it.
-- Reads: any authenticated user can read any review (public reputation signal).
-- Writes: only the reviewer can insert their own review.
--         Reviews are immutable once written — no UPDATE for tenants/hosts.
--         DELETE is reserved for service role (moderation) only.

ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;

-- Any authenticated user may read reviews (property page, host profiles)
CREATE POLICY reviews_authenticated_read ON reviews
  FOR SELECT
  USING (auth.role() = 'authenticated');

-- A user may only submit a review where they are the reviewer
CREATE POLICY reviews_reviewer_insert ON reviews
  FOR INSERT
  WITH CHECK (auth.uid() = reviewer_id);

-- Reviews are immutable for normal users; service role can UPDATE for moderation.
-- No UPDATE policy for role='authenticated' — intentional.

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. wallet_challenges
-- ═══════════════════════════════════════════════════════════════════════════════
-- These are ephemeral Stellar wallet challenge tokens generated server-side.
-- No authenticated client should ever read or write this table directly;
-- all access flows through the backend service role.
-- Enabling RLS with no client policies effectively blocks all client access.

ALTER TABLE wallet_challenges ENABLE ROW LEVEL SECURITY;

-- No SELECT/INSERT/UPDATE/DELETE policies for client roles.
-- Service role bypasses RLS and handles all operations.

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. idempotency_keys
-- ═══════════════════════════════════════════════════════════════════════════════
-- Scoped strictly to the owning user.  The service layer writes these;
-- in theory a user should not query this table directly, but if they do
-- they may only see their own keys.

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;

-- A user may read only their own idempotency keys
CREATE POLICY idempotency_keys_own_select ON idempotency_keys
  FOR SELECT
  USING (auth.uid() = user_id);

-- Service role handles INSERT/UPDATE/DELETE (expiry cleanup, dedup checks).
-- No client INSERT policy — clients never directly write idempotency keys.

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. messages
-- ═══════════════════════════════════════════════════════════════════════════════
-- A conversation is visible to both the sender and the recipient.
-- Only the sender may create a message.
-- Only the recipient may mark a message as read (UPDATE read_at).
-- Deletion is reserved for the service role (data-retention jobs).

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- Both sender and recipient can read messages in their conversation
CREATE POLICY messages_participant_select ON messages
  FOR SELECT
  USING (
    auth.uid() = sender_id OR auth.uid() = recipient_id
  );

-- Only the authenticated sender can create a message
CREATE POLICY messages_sender_insert ON messages
  FOR INSERT
  WITH CHECK (auth.uid() = sender_id);

-- Only the recipient can mark messages as read
CREATE POLICY messages_recipient_update ON messages
  FOR UPDATE
  USING (auth.uid() = recipient_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. blockchain_logs
-- ═══════════════════════════════════════════════════════════════════════════════
-- Append-only audit trail for Stellar/Soroban operations.
-- Clients must never read or write blockchain_logs directly.
-- All writes are service-role (loggingService.logBlockchainOperation).
-- Read access is reserved for admin tooling via the service role.

ALTER TABLE blockchain_logs ENABLE ROW LEVEL SECURITY;

-- No client-facing policies.  Service role handles all access.

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. reports
-- ═══════════════════════════════════════════════════════════════════════════════
-- Any authenticated user can file a report (reporter_id = auth.uid()).
-- A reporter can read their own reports to check resolution status.
-- Moderators/admins read all reports through the service role.
-- Status updates (resolve/dismiss) are service-role only.

ALTER TABLE reports ENABLE ROW LEVEL SECURITY;

-- Reporters can view their own submitted reports
CREATE POLICY reports_reporter_select ON reports
  FOR SELECT
  USING (auth.uid() = reporter_id);

-- Any authenticated user can file a new report against a property or review
CREATE POLICY reports_authenticated_insert ON reports
  FOR INSERT
  WITH CHECK (
    auth.uid() = reporter_id
    AND auth.role() = 'authenticated'
  );

-- Resolution updates are service-role only; no UPDATE policy for authenticated role.

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. booking_modifications
-- ═══════════════════════════════════════════════════════════════════════════════
-- A modification is visible to:
--   a) The user who requested it (requested_by).
--   b) The tenant on the underlying booking (tenant can request changes).
--   c) The property owner (to approve/reject).
-- Service role handles status transitions (approve/reject workflows).

ALTER TABLE booking_modifications ENABLE ROW LEVEL SECURITY;

-- Tenant who owns the booking can read modification requests for their booking
CREATE POLICY booking_modifications_tenant_select ON booking_modifications
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM bookings
      WHERE bookings.id = booking_modifications.booking_id
        AND bookings.tenant_id = auth.uid()
    )
  );

-- Property owner can read modification requests for bookings on their properties
CREATE POLICY booking_modifications_owner_select ON booking_modifications
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM bookings
      JOIN properties ON properties.id = bookings.property_id
      WHERE bookings.id = booking_modifications.booking_id
        AND properties.owner_id = auth.uid()
    )
  );

-- The requester can also see modification requests they submitted
CREATE POLICY booking_modifications_requester_select ON booking_modifications
  FOR SELECT
  USING (auth.uid() = requested_by);

-- Tenant (as requester) can submit a modification request
CREATE POLICY booking_modifications_tenant_insert ON booking_modifications
  FOR INSERT
  WITH CHECK (
    auth.uid() = requested_by
    AND EXISTS (
      SELECT 1 FROM bookings
      WHERE bookings.id = booking_modifications.booking_id
        AND bookings.tenant_id = auth.uid()
    )
  );

-- Status updates (approve/reject) are service-role only.

-- ═══════════════════════════════════════════════════════════════════════════════
-- 8. search_analytics
-- ═══════════════════════════════════════════════════════════════════════════════
-- Row insertion is service-role only (search handler writes anonymised records).
-- Authenticated users may read their own search history (user_id = auth.uid()).
-- Aggregate analytics (query suggestions) are served via a SECURITY DEFINER
-- function, not direct table access, so no broad SELECT policy is needed.

ALTER TABLE search_analytics ENABLE ROW LEVEL SECURITY;

-- Users can read their own search history rows (user_id nullable — only
-- rows with a matching user_id are returned; anonymous rows are invisible)
CREATE POLICY search_analytics_own_select ON search_analytics
  FOR SELECT
  USING (
    user_id IS NOT NULL
    AND auth.uid() = user_id
  );

-- No INSERT policy for client role — the backend service role writes all rows.

-- ═══════════════════════════════════════════════════════════════════════════════
-- 9. host_follows  (idempotent guard — policies already in 00023)
-- ═══════════════════════════════════════════════════════════════════════════════
-- RLS was enabled in 00023_create_host_follows_table.sql.
-- This block is a documentation checkpoint only; no-op in production.
-- Policies: host_follows_select, host_follows_insert, host_follows_delete
-- already created in migration 00023.

-- ═══════════════════════════════════════════════════════════════════════════════
-- 10. property_images  (idempotent guard — policies already in 00012)
-- ═══════════════════════════════════════════════════════════════════════════════
-- RLS was enabled in 00012_create_property_images_table.sql.
-- Policies: "Owners can manage property images", "Anyone can read property images"
-- already created in migration 00012.

-- ═══════════════════════════════════════════════════════════════════════════════
-- 11. audit_logs  (idempotent guard — RLS already in 00028)
-- ═══════════════════════════════════════════════════════════════════════════════
-- RLS and audit_logs_service_role_only policy created in 00028_create_audit_and_payments.sql.

-- ═══════════════════════════════════════════════════════════════════════════════
-- 12. payments  (idempotent guard — RLS already in 00028)
-- ═══════════════════════════════════════════════════════════════════════════════
-- RLS, payments_tenant_read, payments_service_role_all created in 00028.

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification helper:
-- After applying this migration you can audit RLS coverage with:
--
--   SELECT tablename, rowsecurity
--   FROM pg_tables
--   WHERE schemaname = 'public'
--   ORDER BY tablename;
--
-- Every sensitive table should show rowsecurity = true.
-- ─────────────────────────────────────────────────────────────────────────────
