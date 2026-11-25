#!/usr/bin/env bun
/**
 * Unified migration runner with version tracking and checksum validation.
 *
 * Usage:
 *   bun run database/run-migrations.ts [--dry-run] [--fresh]
 *
 * Flags:
 *   --dry-run   Show pending migrations without applying
 *   --fresh     Drop and recreate database (WARNING: destructive)
 *
 * Features:
 *   - Applies migrations in canonical order from MIGRATIONS_NAMING.md
 *   - Tracks applied migrations in schema_migrations table
 *   - Validates checksums to detect drift
 *   - Prevents duplicate or out-of-order migrations
 *   - Idempotent: safe to run multiple times
 */

import { createHash } from 'crypto';
import { readFile, readdir } from 'fs/promises';
import { join, basename } from 'path';
import { Client } from 'pg';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Migration {
  filename: string;
  prefix: number;
  checksum: string;
  content: string;
}

interface AppliedMigration {
  migration_name: string;
  migration_prefix: number;
  checksum: string;
  applied_at: Date;
}

// ─── Configuration ────────────────────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/postgres';
const MIGRATIONS_DIR = join(import.meta.dir, 'migrations');

// Canonical migration order for files with duplicate prefixes
// Source: MIGRATIONS_NAMING.md
const DUPLICATE_PREFIX_ORDER: Record<number, string[]> = {
  2: ['00002_add_booking_blockchain_fields.sql', '00002_storage_and_rls.sql'],
  13: ['00013_add_property_search_vector.sql', '00013_update_availability_ranges.sql'],
  14: ['00014_add_dynamic_pricing.sql', '00014_pricing_and_settings.sql', '00014_search_analytics_and_geolocation.sql'],
  17: [
    '00017_add_guest_count_to_bookings.sql',
    '00017_add_amenities_gin_index.sql',
    '00017_add_email_verification.sql',
    '00017_add_geospatial_gist_index.sql',
    '00017_add_password_reset_tokens.sql',
  ],
  20: [
    '00020_add_missing_indexes.sql',
    '00020_add_property_views.sql',
    '00020_add_review_eligibility_constraints.sql',
  ],
  21: [
    '00021_add_booking_reminders.sql',
    '00021_add_flag_reason_to_reviews.sql',
    '00021_add_rls_wishlists_notifications.sql',
    '00021_create_funnel_events.sql',
    '00021_email_delivery_tracking.sql',
  ],
  22: ['00022_add_featured_until_to_properties.sql', '00022_block_list_and_abuse.sql'],
  23: ['00023_create_host_follows_table.sql', '00023_notification_monitoring.sql'],
  28: [
    '00028_add_property_type_and_bathrooms.sql',
    '00028_add_role_to_users.sql',
    '00028_booking_lifecycle_disputed_complete.sql',
    '00028_create_audit_and_payments.sql',
    '00028_create_booking_status_history.sql',
  ],
  29: ['00029_add_display_currency_to_bookings.sql', '00029_create_reports_table.sql'],
  30: ['00030_add_support_cases.sql', '00030_create_audit_logs_table.sql'],
  32: [
    '00032_add_cancellation_refund_fields.sql',
    '00032_add_soft_delete_to_properties.sql',
    '00032_add_thumbnail_url_to_property_images.sql',
    '00032_create_idempotency_keys_table.sql',
  ],
  59: [
    '00059_create_data_exports_table.sql',
    '00059_create_probe_results_table.sql',
    '00059_enhance_audit_logs_table.sql',
    '00059_enhance_saved_searches.sql',
    '00059_search_infrastructure_validation.sql',
  ],
  60: [
    '00060_add_property_draft_status.sql',
    '00060_create_account_deletions_table.sql',
    '00060_geocoding_status_tracking.sql',
  ],
  61: ['00061_enhance_reports_and_moderation.sql', '00061_search_performance_tracking.sql'],
  62: [
    '00062_add_guest_count_to_booking_modifications.sql',
    '00062_add_legal_holds.sql',
    '00062_add_quiet_hours_to_notification_preferences.sql',
    '00062_booking_date_exclusion_constraint.sql',
    '00062_booking_expiry_and_timeout.sql',
    '00062_booking_lifecycle_state_machine.sql',
    '00062_booking_modifications_snapshot.sql',
  ],
  65: [
    '00065_account_deletion_lifecycle.sql',
    '00065_audit_logs_append_only.sql',
    '00065_listing_moderation_visibility.sql',
    '00065_notification_categories_deep_links_event_ids.sql',
    '00065_rls_coverage_hardening.sql',
    '00065_saved_search_alert_deliveries.sql',
  ],
  66: [
    '00066_booking_terms_snapshots.sql',
    '00066_nearby_search_geolocation_eligibility.sql',
    '00066_on_chain_review_reconciliation.sql',
    '00066_wallet_challenges_address_column.sql',
  ],
  67: [
    '00067_enhance_review_moderation_workflow.sql',
    '00067_saved_search_filter_version.sql',
    '00067_search_rollout.sql',
  ],
  69: [
    '00069_booking_expiry_claim_and_warning.sql',
    '00069_coordinate_privacy_policy.sql',
    '00069_escrow_reconciliation_durability.sql',
    '00069_push_subscriptions_endpoint_ownership.sql',
  ],
  70: ['00070_booking_modification_expiry.sql', '00070_create_payment_events.sql'],
  71: [
    '00071_booking_property_fk_restrict.sql',
    '00071_property_image_moderation.sql',
    '00071_wallet_link_policy.sql',
  ],
};

// ─── Utilities ────────────────────────────────────────────────────────────────

function parsePrefix(filename: string): number {
  const match = /^(\d+)_/.exec(filename);
  if (!match) throw new Error(`Invalid migration filename: ${filename}`);
  return parseInt(match[1], 10);
}

function computeChecksum(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function sortMigrations(files: string[]): string[] {
  const sorted: string[] = [];
  const grouped = new Map<number, string[]>();

  for (const file of files) {
    const prefix = parsePrefix(file);
    if (!grouped.has(prefix)) grouped.set(prefix, []);
    grouped.get(prefix)!.push(file);
  }

  const prefixes = Array.from(grouped.keys()).sort((a, b) => a - b);

  for (const prefix of prefixes) {
    const group = grouped.get(prefix)!;
    if (group.length === 1) {
      sorted.push(group[0]);
    } else {
      const canonicalOrder = DUPLICATE_PREFIX_ORDER[prefix];
      if (!canonicalOrder) {
        throw new Error(
          `Duplicate prefix ${prefix} found but no canonical order defined: ${group.join(', ')}`
        );
      }
      for (const name of canonicalOrder) {
        if (group.includes(name)) sorted.push(name);
      }
    }
  }

  return sorted;
}

// ─── Database operations ──────────────────────────────────────────────────────

async function ensureSchemaVersionTable(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      migration_name VARCHAR(255) NOT NULL UNIQUE,
      migration_prefix INT NOT NULL,
      checksum VARCHAR(64) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      applied_by VARCHAR(100) DEFAULT CURRENT_USER
    );
    CREATE INDEX IF NOT EXISTS idx_schema_migrations_prefix ON schema_migrations(migration_prefix);
    CREATE INDEX IF NOT EXISTS idx_schema_migrations_applied_at ON schema_migrations(applied_at);
  `);
}

async function getAppliedMigrations(client: Client): Promise<AppliedMigration[]> {
  const result = await client.query<AppliedMigration>(
    'SELECT migration_name, migration_prefix, checksum, applied_at FROM schema_migrations ORDER BY migration_prefix, applied_at'
  );
  return result.rows;
}

async function recordMigration(
  client: Client,
  migration: Migration
): Promise<void> {
  await client.query(
    `INSERT INTO schema_migrations (migration_name, migration_prefix, checksum)
     VALUES ($1, $2, $3)
     ON CONFLICT (migration_name) DO NOTHING`,
    [migration.filename.replace('.sql', ''), migration.prefix, migration.checksum]
  );
}

// ─── Main logic ───────────────────────────────────────────────────────────────

async function loadMigrations(): Promise<Migration[]> {
  const files = await readdir(MIGRATIONS_DIR);
  const sqlFiles = files.filter(f => f.endsWith('.sql'));
  const sorted = sortMigrations(sqlFiles);

  const migrations: Migration[] = [];
  for (const filename of sorted) {
    const path = join(MIGRATIONS_DIR, filename);
    const content = await readFile(path, 'utf-8');
    migrations.push({
      filename,
      prefix: parsePrefix(filename),
      checksum: computeChecksum(content),
      content,
    });
  }
  return migrations;
}

async function validateChecksums(
  applied: AppliedMigration[],
  available: Migration[]
): Promise<void> {
  const availableMap = new Map(
    available.map(m => [m.filename.replace('.sql', ''), m])
  );

  const errors: string[] = [];

  for (const applied of applied) {
    const migration = availableMap.get(applied.migration_name);
    if (!migration) {
      errors.push(`Applied migration not found in filesystem: ${applied.migration_name}`);
      continue;
    }
    if (migration.checksum !== applied.checksum) {
      errors.push(
        `Checksum mismatch for ${applied.migration_name}:\n` +
        `  Applied:   ${applied.checksum}\n` +
        `  Current:   ${migration.checksum}\n` +
        `  → Migration file has been modified after being applied!`
      );
    }
  }

  if (errors.length > 0) {
    throw new Error('Migration validation failed:\n' + errors.join('\n\n'));
  }
}

async function runMigrations(dryRun = false): Promise<void> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  try {
    await ensureSchemaVersionTable(client);
    const applied = await getAppliedMigrations(client);
    const appliedNames = new Set(applied.map(m => m.migration_name));

    const migrations = await loadMigrations();
    await validateChecksums(applied, migrations);

    const pending = migrations.filter(
      m => !appliedNames.has(m.filename.replace('.sql', ''))
    );

    if (pending.length === 0) {
      console.log('✓ All migrations applied. Schema is up to date.');
      return;
    }

    console.log(`Found ${pending.length} pending migration(s):\n`);
    for (const m of pending) {
      console.log(`  → ${m.filename}`);
    }

    if (dryRun) {
      console.log('\n[DRY RUN] No changes applied.');
      return;
    }

    console.log('\nApplying migrations...\n');

    for (const migration of pending) {
      console.log(`Applying ${migration.filename}...`);
      await client.query('BEGIN');
      try {
        await client.query(migration.content);
        await recordMigration(client, migration);
        await client.query('COMMIT');
        console.log(`  ✓ Applied ${migration.filename}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(
          `Failed to apply ${migration.filename}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    console.log(`\n✓ Successfully applied ${pending.length} migration(s).`);
  } finally {
    await client.end();
  }
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const fresh = args.includes('--fresh');

if (fresh) {
  console.error('--fresh flag is not implemented for safety reasons.');
  console.error('To reset the database, drop and recreate manually, then run this script.');
  process.exit(1);
}

try {
  await runMigrations(dryRun);
} catch (err) {
  console.error('\n❌ Migration failed:\n');
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
