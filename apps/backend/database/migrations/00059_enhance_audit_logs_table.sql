-- Enhance audit_logs table with correlation IDs, success tracking, and bulk operation support.

ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS correlation_id UUID,
  ADD COLUMN IF NOT EXISTS success BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS error TEXT,
  ADD COLUMN IF NOT EXISTS target_ids UUID[] DEFAULT '{}';

-- Create indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_audit_logs_correlation_id ON audit_logs(correlation_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_action ON audit_logs(actor_id, action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource ON audit_logs(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp_desc ON audit_logs(created_at DESC);

-- ---------------------------------------------------------------------------
-- Indexed filter columns for admin audit-log search
-- ---------------------------------------------------------------------------

ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS actor_role TEXT,
  ADD COLUMN IF NOT EXISTS request_id TEXT,
  ADD COLUMN IF NOT EXISTS ip_hash TEXT,
  ADD COLUMN IF NOT EXISTS outcome TEXT;

-- Composite indexes supporting paginated, filterable admin audit views.
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_created
  ON audit_logs(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action_created
  ON audit_logs(action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_target_created
  ON audit_logs(target_type, target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_desc
  ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_request_id
  ON audit_logs(request_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_outcome_created
  ON audit_logs(outcome, created_at DESC);

-- ---------------------------------------------------------------------------
-- Retention policy
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS audit_log_retention_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_type TEXT,
  action TEXT,
  retention_days INTEGER NOT NULL CHECK (retention_days > 0),
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Only one default retention policy may exist.
CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_log_retention_default
  ON audit_log_retention_policies(is_default)
  WHERE is_default = TRUE;

-- Lookup index for resolving the applicable policy.
CREATE INDEX IF NOT EXISTS idx_audit_log_retention_lookup
  ON audit_log_retention_policies(resource_type, action);

INSERT INTO audit_log_retention_policies (resource_type, action, retention_days, is_default)
SELECT NULL, NULL, 365, TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM audit_log_retention_policies WHERE is_default = TRUE
);

-- ---------------------------------------------------------------------------
-- Redaction function: strips tokens, passwords, and PII from metadata at write time
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION audit_logs_redact_metadata(input JSONB)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  redacted JSONB;
  sensitive_keys TEXT[] := ARRAY[
    'password', 'passwd', 'pwd', 'secret', 'token', 'access_token',
    'refresh_token', 'id_token', 'api_key', 'apikey', 'authorization',
    'auth', 'cookie', 'set-cookie', 'session', 'session_id', 'csrf',
    'csrf_token', 'private_key', 'client_secret', 'credit_card', 'card_number',
    'cvv', 'cvc', 'ssn', 'social_security_number', 'tax_id', 'national_id',
    'passport', 'date_of_birth', 'dob', 'email', 'phone', 'phone_number',
    'address', 'ip_address', 'iban', 'account_number'
  ];
  key TEXT;
BEGIN
  IF input IS NULL THEN
    RETURN NULL;
  END IF;

  IF jsonb_typeof(input) = 'object' THEN
    redacted := '{}'::JSONB;
    FOR key IN SELECT jsonb_object_keys(input) LOOP
      IF lower(key) = ANY (sensitive_keys) THEN
        redacted := redacted || jsonb_build_object(key, '[REDACTED]');
      ELSE
        redacted := redacted || jsonb_build_object(
          key,
          audit_logs_redact_metadata(input -> key)
        );
      END IF;
    END LOOP;
    RETURN redacted;
  ELSIF jsonb_typeof(input) = 'array' THEN
    SELECT COALESCE(jsonb_agg(audit_logs_redact_metadata(elem)), '[]'::JSONB)
      INTO redacted
      FROM jsonb_array_elements(input) AS elem;
    RETURN redacted;
  ELSE
    RETURN input;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Append-only enforcement + write-time redaction trigger
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION audit_logs_enforce_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'audit_logs is append-only: UPDATE is not permitted';
  ELSIF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'audit_logs is append-only: DELETE is not permitted';
  END IF;
  RETURN NULL;
END;
$$;

-- Drop any pre-existing append-only trigger before recreating it.
DROP TRIGGER IF EXISTS trg_audit_logs_append_only ON audit_logs;
CREATE TRIGGER trg_audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW
  EXECUTE FUNCTION audit_logs_enforce_append_only();

-- Redact sensitive fields in metadata before the row is persisted.
CREATE OR REPLACE FUNCTION audit_logs_redact_before_write()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.metadata := audit_logs_redact_metadata(NEW.metadata);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_logs_redact_metadata ON audit_logs;
CREATE TRIGGER trg_audit_logs_redact_metadata
  BEFORE INSERT ON audit_logs
  FOR EACH ROW
  EXECUTE FUNCTION audit_logs_redact_before_write();