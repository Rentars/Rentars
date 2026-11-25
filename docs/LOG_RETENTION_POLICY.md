# Log Retention and Access Policy

This document is the authoritative reference for log classification, retention
windows, access controls, and the incident response procedure for any detected
credential in log data. It applies to all structured logs produced by the
Rentars backend (`apps/backend`) and consumed by the log-aggregation pipeline.

---

## Table of contents

1. [Log classification](#1-log-classification)
2. [Redaction at source](#2-redaction-at-source)
3. [Retention limits](#3-retention-limits)
4. [Access controls](#4-access-controls)
5. [Secret scanning in CI](#5-secret-scanning-in-ci)
6. [Incident response — credential detected in logs](#6-incident-response--credential-detected-in-logs)
7. [Review cadence](#7-review-cadence)

---

## 1. Log classification

Every log line emitted by the backend falls into one of the following classes.
The class determines the retention window and who may read the log.

| Class | Examples | Sensitivity | Retention |
|---|---|---|---|
| **Access** | HTTP method, path, status, durationMs, requestId, userId (ID only), IP | Low | 90 days |
| **Audit** | `audit_logs` table rows — action, actorId, resourceId, success | Medium | 365 days (never deleted by retention jobs; see §3) |
| **Security** | `security_logs` table rows — login_success/failure, token_revoked | Medium | 180 days |
| **Blockchain** | `blockchain_logs` table rows — operation, input/result (redacted), txHash | Medium | 90 days (env `RETENTION_BLOCKCHAIN_LOGS_DAYS`) |
| **Application error** | 5xx stack traces, unhandled rejections | Low–Medium | 90 days |
| **Debug** | Only emitted when `LOG_LEVEL=debug`; never enabled in production | Low | 7 days |

**Sensitive data classes that must never appear in any log line:**

- Raw passwords, secrets, tokens, API keys, seed phrases
- Payment card numbers, CVV/CVC, expiry dates
- Full SSNs, national ID numbers, passport numbers
- Full email addresses in body or meta fields (user IDs are permitted)
- Private Stellar keypairs (S… keys)
- Raw provider response bodies (TrustlessWork, Supabase auth responses)
- Raw request bodies on auth or payment routes

---

## 2. Redaction at source

Redaction is applied at the point of emission, before any log leaves the
process. The implementation lives in `apps/backend/src/utils/redact.ts`.

### 2.1 Field-name allowlist model

`structuredLog` (in `src/middleware/logging.middleware.ts`) separates fields
into two buckets:

- **Safe schema keys** — `level`, `message`, `timestamp`, `requestId`,
  `userId`, `method`, `path`, `status`, `durationMs`, `ip`, `userAgent`,
  `route`. These pass through verbatim.
- **Extra fields** — everything else. Passed through `redactLogFields` before
  serialisation.

`redactLogFields` replaces the _value_ of any key matching
`SENSITIVE_FIELD_PATTERN` (defined in `redact.ts`) with `"[REDACTED]"`.

### 2.2 Value-pattern scrubbing

Even on safe fields, string values are scanned for credential-shaped patterns:

| Pattern | Replacement |
|---|---|
| JWT (three base64url segments) | `[JWT_REDACTED]` |
| `Bearer <token>` | `Bearer [TOKEN_REDACTED]` |
| Stellar secret key (`S` + 55 chars) | `[STELLAR_SECRET_REDACTED]` |
| 64-char hex string | `[HEX_SECRET_REDACTED]` |
| Email address | `[EMAIL_REDACTED]` |

### 2.3 Request header redaction

`requestLoggingMiddleware` calls `redactRequestHeaders` before logging. Only
the following headers are preserved:

```
content-type  content-length  user-agent  accept  accept-encoding
accept-language  x-request-id  x-forwarded-for  x-real-ip
origin  referer  host
```

All other headers — including `Authorization`, `Cookie`, `x-api-key` — are
replaced with `"[REDACTED]"`.

### 2.4 Audit log meta redaction

`auditLogger.service.ts` runs `sanitizeAuditMeta` on every `meta` object
before writing to `audit_logs`. The same `SENSITIVE_META_KEYS` regex removes
token, secret, password, key, card, ssn, cvv, signature, private, cookie,
authorization, payload, raw, body, and content fields.

### 2.5 Security logger meta redaction

`SecurityLogger.logAuthEvent` (in `logging.service.ts`) passes `meta`
through `redactLogFields` before spreading onto the log entry, so caller
errors that forward a full request object cannot leak credentials.

### 2.6 Blockchain operation log redaction

`LoggingService.logBlockchainOperation` redacts both `input` and `result`
before inserting into `blockchain_logs` and before the console emit.

---

## 3. Retention limits

Retention windows are set via environment variables and enforced by the
scheduled retention sweep (see `src/services/dataRetention.service.ts`).
The defaults below apply unless overridden in the deployment environment.

| Data class | Environment variable | Default | Notes |
|---|---|---|---|
| Blockchain operation logs | `RETENTION_BLOCKCHAIN_LOGS_DAYS` | 90 days | |
| Blockchain sync logs | `RETENTION_SYNC_LOG_DAYS` | 30 days | |
| Read in-app notifications | `RETENTION_NOTIFICATIONS_READ_DAYS` | 90 days | |
| Unread in-app notifications | `RETENTION_NOTIFICATIONS_UNREAD_DAYS` | 180 days | |
| Search analytics | `RETENTION_SEARCH_ANALYTICS_DAYS` | 365 days | |
| Property views | `RETENTION_PROPERTY_VIEWS_DAYS` | 90 days | |
| Failed/timed-out payment intents | `RETENTION_PAYMENTS_FAILED_DAYS` | 90 days | |
| Soft-deleted properties | `RETENTION_SOFT_DELETED_PROPERTIES_DAYS` | 180 days | |
| Wallet challenge tokens (after expiry) | `RETENTION_WALLET_CHALLENGES_HOURS` | 1 hour | |
| Password reset tokens | `RETENTION_PASSWORD_RESET_TOKENS_DAYS` | 7 days | |
| Account deletion records | `RETENTION_ACCOUNT_DELETIONS_CLOSED_DAYS` | 30 days | |

**Records that are never automatically deleted:**

- `audit_logs` — financial and compliance record; retained indefinitely
- Confirmed payment records with an `escrow_id`
- Completed bookings with an `escrow_id`
- Dispute evidence files in Supabase Storage

> **Legal minimum.** Never reduce any retention window below your applicable
> legal minimum (e.g. GDPR Article 17 erasure obligations, financial record
> keeping requirements). These defaults exceed typical compliance minima but
> must be reviewed before any change.

**Access log retention (stdout / log aggregator):**

| Environment | Retention |
|---|---|
| Production (Loki / CloudWatch) | 90 days |
| Staging | 30 days |
| Development (local) | No persistence — stdout only |

Rotation is configured at the Docker logging driver level in
`infra/docker-compose.staging.yml` (`max-size: 50m`, `max-file: 5`).
The log aggregator enforces the 90-day window via its native retention policy.

---

## 4. Access controls

### 4.1 `/metrics` endpoint

The Prometheus metrics endpoint at `GET /metrics` is protected:

- When `METRICS_TOKEN` is set: requires `Authorization: Bearer <token>`.
- When `METRICS_TOKEN` is unset: restricted to `127.0.0.1` / `::1` only.

No user PII appears in metrics labels (only IDs, routes, status codes, and
outcome labels). See `src/middleware/metrics.middleware.ts`.

### 4.2 `audit_logs` table

Access is controlled by Supabase RLS. Only:

- Service-role key operations (backend only, never client-side)
- Admin users with the `admin` role JWT claim

may read `audit_logs`. The `auditLogger.query()` method is restricted to
authenticated admins at the route layer.

### 4.3 `security_logs` table

Readable only via the service-role key. Not exposed through any public API
endpoint.

### 4.4 `blockchain_logs` table

Readable only via the service-role key. The `input_json` and `result_json`
columns contain redacted data (see §2.6) so even a compromised service-role
key cannot expose original credential values.

### 4.5 Production log aggregator

Access to the production log aggregator (Loki, CloudWatch Logs, etc.) is
restricted to:

- On-Call SRE
- Backend On-Call
- Incident Commander (during active incidents)

Access is role-based and audited. Developers may access staging logs.
Production log access requires a named on-call assignment or an active incident.

---

## 5. Secret scanning in CI

Secret scanning runs on every push and pull request via
`.github/workflows/security-scan.yml`.

### 5.1 Gitleaks (repository secret scan)

- Full git history is scanned on PRs (`fetch-depth: 0`).
- Configuration is in `.gitleaks.toml` (extends the default ruleset).
- Known-safe values (Supabase demo JWTs, test fixture keys) are listed in the
  gitleaks allowlist.
- The workflow includes a **self-test**: it rescans the planted fixture file
  without the allowlist to confirm gitleaks can still detect secrets. If the
  self-test fails, the scanner is broken, not safe.
- Failure blocks the PR merge.

### 5.2 Log-output secret scan (CI step)

For test runs that capture stdout, the CI pipeline pipes test output through
a grep for known credential patterns as a defence-in-depth check:

```yaml
# In .github/workflows/ci.yml — unit-tests job
- name: Check test output for accidental credential logging
  run: |
    if grep -qE \
      'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|Bearer [A-Za-z0-9]+|S[A-Z2-7]{55}' \
      /tmp/unit-test-output.txt 2>/dev/null; then
      echo "::error::Potential credential found in test log output. Review redaction."
      exit 1
    fi
```

This step is documented here; the CI workflow is updated to capture output
and run the scan. See `.github/workflows/security-scan.yml` §5.3.

### 5.3 Dependency audits

- `yarn audit --level high` — web workspace
- `bun audit --level high` — backend workspace
- `cargo audit` — Rust/Soroban contracts
- `trivy` filesystem scan — Dockerfiles (HIGH/CRITICAL CVEs)

All run on every push and nightly at 02:00 UTC.

---

## 6. Incident response — credential detected in logs

If a credential (token, API key, password, seed phrase) is found in log data
or in a git commit, follow this procedure immediately.

### Step 1 — Contain (< 5 minutes)

1. Determine the credential type (JWT secret, API key, Stellar keypair, etc.).
2. Revoke or rotate the credential immediately using the relevant procedure:
   - **JWT_SECRET** → `RUNBOOKS.md DR-7` (zero-downtime rotation)
   - **TRUSTLESS_WORK_API_KEY** → `RUNBOOKS.md DR-7`
   - **STELLAR_ADMIN_SECRET** → `RUNBOOKS.md DR-4` (highest severity)
   - **SUPABASE_SERVICE_ROLE_KEY** → `RUNBOOKS.md DR-7`
   - **SMTP_PASS** → rotate in SMTP provider dashboard; update secret
3. If found in a public git commit, force-rotate immediately regardless of
   whether exploitation is confirmed. Assume the credential is compromised.

### Step 2 — Assess (< 30 minutes)

1. Search `audit_logs` for any actions taken with the compromised credential
   in the window between the commit/log timestamp and revocation:
   ```sql
   SELECT * FROM audit_logs
   WHERE timestamp BETWEEN '<exposure_start>' AND '<revocation_time>'
   ORDER BY timestamp;
   ```
2. Search `security_logs` for any `login_success` or `unauthorized_access`
   events in the same window.
3. Determine whether any unauthorised access, data exfiltration, or
   transaction occurred.

### Step 3 — Notify (< 1 hour)

1. Notify the Incident Commander.
2. If user data was accessed: initiate GDPR/privacy breach assessment.
   - If a notifiable breach: notify the DPA within 72 hours (GDPR Article 33).
3. Document the timeline in an incident report.

### Step 4 — Remediate

1. Purge the credential from the git history using `git filter-repo` (do not
   use `git filter-branch` — it does not rewrite all refs reliably):
   ```bash
   git filter-repo --path <file> --invert-paths
   # or to replace the string throughout history:
   git filter-repo --replace-text <(echo '<leaked_value>==>REDACTED')
   ```
2. Force-push to all remotes after team coordination.
3. Invalidate any GitHub PATs or deploy keys that had read access to the repo
   during the exposure window.
4. Scrub the log entry from the log aggregator if the aggregator supports
   deletion (Loki: `logcli delete`; CloudWatch: manual log event deletion).

### Step 5 — Prevent

1. Add the leaked pattern to `.gitleaks.toml` as an additional rule.
2. Add a test to `tests/unit/redact.test.ts` that proves the pattern is now
   scrubbed.
3. File a post-mortem within 48 hours.

---

## 7. Review cadence

| Event | Action |
|---|---|
| Quarterly | Review retention windows against legal and compliance requirements |
| Each production release | Verify no new log call bypasses redaction (`grep -r 'console.log' src/` and `grep -r 'structuredLog' src/`) |
| After any credential incident | Update §6 procedure with lessons learned; add new gitleaks rule |
| After adding a new external integration | Review what the provider's response body contains and add fields to `SENSITIVE_FIELD_PATTERN` if needed |

**Owner:** Backend On-Call is responsible for keeping this document current.
Changes require a PR reviewed by the Incident Commander or a Backend Lead.
