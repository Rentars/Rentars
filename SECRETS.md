# Secrets Management

This document outlines the secrets required for the Rentars application and how to manage them securely.

## Required Secrets

### Backend (apps/backend)

| Secret | Description | Where to Get |
|--------|-------------|--------------|
| `SUPABASE_URL` | Supabase project URL | Supabase Dashboard → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key with admin privileges | Supabase Dashboard → Project Settings → API → "service_role" key |
| `JWT_SECRET` | Secret for signing JWT tokens | Generate a secure random string (min 32 characters) |
| `REDIS_URL` | Redis connection URL | Your Redis provider or local Redis |
| `TRUSTLESS_WORK_API_KEY` | API key for TrustlessWork escrow | TrustlessWork Dashboard |
| `GEOCODING_API_KEY` | Optional API key for geocoding services | Google Maps API or Mapbox |

### Frontend (apps/web)

| Secret | Description | Where to Get |
|--------|-------------|--------------|
| `NEXT_PUBLIC_API_URL` | Backend API URL | Configuration |
| `NEXT_PUBLIC_STELLAR_NETWORK` | Stellar network (testnet/mainnet) | Configuration |
| `NEXT_PUBLIC_SOROBAN_RPC_URL` | Soroban RPC endpoint | Stellar Documentation |
| `NEXT_PUBLIC_PASSKEY_RP_ID` | Relying Party ID for WebAuthn | Your domain |

## Storage Guidelines

### Local Development

1. Copy `.env.example` to `.env.local` and fill in values
2. Never commit `.env.local` to version control
3. Use `.env.test` for test environments

### Production

1. Use `.env.production.example` as template
2. Store secrets in a secure secrets manager (e.g., AWS Secrets Manager, HashiCorp Vault)
3. Inject secrets as environment variables at runtime
4. Never hardcode secrets in code

## Best Practices

- **Never commit secrets** to version control
- **Rotate secrets regularly** (especially JWT_SECRET)
- **Use different secrets** for development, staging, and production
- **Limit access** to production secrets to essential team members only
- **Use secret scanning tools** to detect accidental commits
- **Encrypt sensitive data** in transit and at rest

## Backup Sources, Retention, and Recovery Objectives

Rental and payment history must be recoverable. The table below documents every backup source, its retention, and the recovery objectives. Owners are responsible for verifying that backups exist and that drills are executed on schedule.

| Source | What is backed up | Method | Retention | RPO | RTO | Owner |
|--------|-------------------|--------|-----------|-----|-----|-------|
| Database (Supabase Postgres) | Bookings, payments, escrow records, users | Automated daily snapshots + PITR (WAL) | 30 days daily, 7 days PITR | 15 minutes (PITR) | 4 hours | Backend Lead |
| Object storage (listing images, documents) | Uploaded media and attachments | Provider versioning + cross-region replication | 30 days versions | 24 hours | 8 hours | Platform/DevOps |
| Configuration | `.env.production` schema, infra config, secrets manager entries | Secrets manager versioning + IaC in version control | 90 days versions | 24 hours | 4 hours | Platform/DevOps |

RPO (Recovery Point Objective) = maximum acceptable data loss. RTO (Recovery Time Objective) = maximum acceptable downtime. Targets are reviewed quarterly and after every drill.

## Sanitized Restore Procedure

Restores for drills and developer environments must **never** copy production secrets. Follow these steps:

1. Restore the database snapshot into an **isolated** environment (separate Supabase project or local Postgres), never into production or a shared staging instance.
2. Do **not** restore the production secrets manager or `.env.production`. Generate fresh, non-production secrets for the isolated environment from `.env.example` / `.env.test`.
3. Scrub or replace any secret-bearing columns (e.g., API keys, tokens) with dummy values before handing the environment to developers.
4. Keep the restored environment network-isolated and destroy it after the drill or verification is complete.
5. Record the restore in the drill log (see below) including duration and any remediation actions.

## Post-Restore Verification

After every restore, verify migration compatibility and key integrity:

- **Migration compatibility**: confirm the restored schema matches the expected migration version (`supabase migration list` / migration ledger) and that the application boots against it.
- **Key integrity queries**: verify core booking/payment relationships, e.g. every payment references an existing booking, every booking has a valid renter/owner, and escrow records reconcile with payments. Run the checks bundled in `scripts/backup-restore-drill.sh`.

## Restore Drill Schedule and Evidence

- Drills run **monthly** (first business week) and after any schema or infrastructure change affecting recovery.
- Use `scripts/backup-restore-drill.sh` to automate backup validation and the isolated restore, and `scripts/recovery-drill.sh` to run the end-to-end drill and integrity checks.
- Evidence (drill log with date, operator, RPO/RTO achieved, duration, verification results, and remediation actions) is retained for **12 months** in the operations runbook / incident tracker.
- Failed drills open a remediation ticket owned by the source owner above and are re-run within 5 business days.