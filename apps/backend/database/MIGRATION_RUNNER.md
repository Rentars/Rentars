# Migration Runner Documentation

## Overview

The unified migration runner (`run-migrations.ts`) provides a single, authoritative way to apply database migrations with version tracking, checksum validation, and ordering guarantees.

## Authoritative Migration Location

**All migrations are now located in `apps/backend/database/migrations/`.**

The root-level `database/migrations/` directory contains legacy blockchain sync migrations that are **NOT** part of the main schema and should be migrated separately via their own runner.

## Usage

### Apply Pending Migrations

```bash
cd apps/backend
bun run database/run-migrations.ts
```

This will:
1. Connect to the database specified by `DATABASE_URL` environment variable
2. Create `schema_migrations` table if it doesn't exist
3. Validate checksums of all applied migrations
4. Apply pending migrations in canonical order
5. Record each migration with its checksum

### Dry Run (Preview)

```bash
bun run database/run-migrations.ts --dry-run
```

Shows which migrations would be applied without making changes.

### Environment Variables

- `DATABASE_URL` — PostgreSQL connection string (default: `postgresql://postgres:postgres@localhost:5432/postgres`)

## Features

### Version Tracking

The `schema_migrations` table tracks:
- Migration filename
- Numeric prefix for ordering
- SHA-256 checksum of file content
- Timestamp and user who applied it

### Checksum Validation

Before applying new migrations, the runner validates that all previously-applied migrations have matching checksums. This detects if a migration file has been modified after being applied.

**If a checksum mismatch is detected:**
- The runner will abort with a clear error message
- Never modify an applied migration file
- Create a new migration to make corrections

### Ordering Guarantees

Migrations with duplicate prefixes are applied in the canonical order defined in `MIGRATIONS_NAMING.md` and hardcoded in the runner. This ensures consistent schema state across all environments.

### Idempotency

Safe to run multiple times. The runner skips migrations that have already been applied (based on `schema_migrations` records).

### Transaction Safety

Each migration is wrapped in a transaction:
- If a migration fails, it rolls back automatically
- The runner aborts immediately on first failure
- No partial migrations are recorded

## CI/CD Integration

### Local Development

```bash
# In package.json
{
  "scripts": {
    "db:migrate": "bun run database/run-migrations.ts",
    "db:migrate:dry-run": "bun run database/run-migrations.ts --dry-run"
  }
}
```

### CI Pipeline

Add to `.github/workflows/ci.yml`:

```yaml
- name: Run database migrations
  env:
    DATABASE_URL: ${{ secrets.DATABASE_URL }}
  run: |
    cd apps/backend
    bun run database/run-migrations.ts
```

### Deployment

For production deployments:

1. **Always dry-run first** in staging with production data
2. Run `bun run database/run-migrations.ts` during deployment window
3. Monitor for errors; failed migrations roll back automatically
4. Verify with: `SELECT * FROM schema_migrations ORDER BY applied_at DESC LIMIT 10;`

## Migration Conflict Resolution

### Scenario: Root vs Backend Directories

The codebase previously had migrations in two locations:
- `apps/backend/database/migrations/` — main application schema
- `database/migrations/` — blockchain sync and ledger tables

**Resolution:**
- Main schema migrations remain in `apps/backend/database/migrations/`
- Root-level migrations are **separate** and handle blockchain sync only
- Use this runner for main schema
- Use a separate runner (TBD) for blockchain sync migrations

### Scenario: Duplicate Migration Names

The runner enforces canonical ordering for duplicate prefixes per `MIGRATIONS_NAMING.md`. If you encounter a migration not listed in the canonical order:

1. Check if it's already been applied to production
2. If yes: add it to the `DUPLICATE_PREFIX_ORDER` map in `run-migrations.ts`
3. If no: rename it to the next available prefix

## Schema State Validation

After running migrations, verify schema convergence:

```bash
# Generate schema dump
pg_dump -s "$DATABASE_URL" > schema-$(date +%Y%m%d).sql

# Compare with baseline
diff baseline-schema.sql schema-$(date +%Y%m%d).sql
```

Fresh and upgraded databases should produce identical schemas.

## Rollback Strategy

No automated rollback is provided. To revert a migration:

1. Create a new migration that undoes the change
2. Prefix it with the next available number
3. Apply via the runner

Manual rollback:

```sql
BEGIN;
-- Manually reverse the migration
DELETE FROM schema_migrations WHERE migration_name = '00075_schema_version_tracking';
COMMIT;
```

## Troubleshooting

### "Checksum mismatch" error

An applied migration file has been modified. This is a critical error.

**Resolution:**
1. Restore the original file from git history
2. If the change is intentional, create a new migration instead

### "Duplicate prefix found but no canonical order defined"

A new duplicate prefix was introduced without updating the runner.

**Resolution:**
1. Check `MIGRATIONS_NAMING.md` for the canonical order
2. Add the order to `DUPLICATE_PREFIX_ORDER` in `run-migrations.ts`

### "Migration file has been modified after being applied"

Similar to checksum mismatch. Never edit applied migrations.

**Resolution:**
1. Revert the file to its original state
2. Create a new migration with the correction

## Future Enhancements

- [ ] Automatic backup before migration
- [ ] Migration lock to prevent concurrent runs
- [ ] Slack/webhook notifications for production migrations
- [ ] Schema diff tool for validation
- [ ] Support for data migrations (separate from schema)
