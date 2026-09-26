/**
 * Unit tests for the validate-migrations script.
 *
 * Tests cover:
 *   - Valid sequential migration sets
 *   - Duplicate prefix detection
 *   - Non-monotonic ordering detection
 *   - Unparseable filename handling
 *   - Real migrations directory (documents existing duplicates)
 */

import { describe, it, expect } from 'bun:test';
import {
  parseMigrationFiles,
  validateMigrations,
} from '../../scripts/validate-migrations.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Create a temporary directory with the given .sql filenames and return its path. */
function makeTempMigrationsDir(filenames: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rentars-mig-test-'));
  for (const name of filenames) {
    fs.writeFileSync(path.join(dir, name), '-- placeholder');
  }
  return dir;
}

// ─── parseMigrationFiles ──────────────────────────────────────────────────────

describe('parseMigrationFiles', () => {
  it('parses valid filenames and extracts prefix numbers', () => {
    const dir = makeTempMigrationsDir([
      '00001_initial_schema.sql',
      '00002_storage_and_rls.sql',
      '00003_triggers.sql',
    ]);
    const { files, unparseable } = parseMigrationFiles(dir);
    expect(files).toHaveLength(3);
    expect(files[0].prefix).toBe(1);
    expect(files[1].prefix).toBe(2);
    expect(files[2].prefix).toBe(3);
    expect(unparseable).toHaveLength(0);
  });

  it('marks files without a numeric prefix as unparseable', () => {
    const dir = makeTempMigrationsDir([
      '00001_initial.sql',
      'no_prefix_here.sql',
      'README.sql',
    ]);
    const { files, unparseable } = parseMigrationFiles(dir);
    expect(files).toHaveLength(1);
    expect(unparseable).toContain('README.sql');
    expect(unparseable).toContain('no_prefix_here.sql');
  });

  it('ignores non-.sql files', () => {
    const dir = makeTempMigrationsDir([
      '00001_schema.sql',
      'README.md',
      'setup.sh',
    ]);
    const { files, unparseable } = parseMigrationFiles(dir);
    expect(files).toHaveLength(1);
    expect(unparseable).toHaveLength(0);
  });

  it('throws when the directory does not exist', () => {
    expect(() => parseMigrationFiles('/nonexistent/path/abc123')).toThrow();
  });
});

// ─── validateMigrations — valid sets ─────────────────────────────────────────

describe('validateMigrations — valid sets', () => {
  it('passes a clean sequential set with no errors', () => {
    const dir = makeTempMigrationsDir([
      '00001_initial_schema.sql',
      '00002_add_rls.sql',
      '00003_triggers.sql',
      '00004_wallet_auth.sql',
    ]);
    const { files } = parseMigrationFiles(dir);
    const result = validateMigrations(files);
    expect(result.duplicates).toHaveLength(0);
    expect(result.nonMonotonic).toHaveLength(0);
  });

  it('passes a set with gaps (001, 003, 010) — gaps are allowed', () => {
    const dir = makeTempMigrationsDir([
      '00001_initial.sql',
      '00003_after_gap.sql',
      '00010_much_later.sql',
    ]);
    const { files } = parseMigrationFiles(dir);
    const result = validateMigrations(files);
    expect(result.duplicates).toHaveLength(0);
    expect(result.nonMonotonic).toHaveLength(0);
  });

  it('passes a single-file set', () => {
    const dir = makeTempMigrationsDir(['00001_init.sql']);
    const { files } = parseMigrationFiles(dir);
    const result = validateMigrations(files);
    expect(result.duplicates).toHaveLength(0);
    expect(result.nonMonotonic).toHaveLength(0);
  });

  it('passes an empty directory', () => {
    const dir = makeTempMigrationsDir([]);
    const { files } = parseMigrationFiles(dir);
    const result = validateMigrations(files);
    expect(result.duplicates).toHaveLength(0);
    expect(result.nonMonotonic).toHaveLength(0);
  });
});

// ─── validateMigrations — duplicate detection ────────────────────────────────

describe('validateMigrations — duplicate prefix detection', () => {
  it('detects a single pair of duplicate prefixes', () => {
    const dir = makeTempMigrationsDir([
      '00001_initial_schema.sql',
      '00002_storage_and_rls.sql',
      '00002_add_booking_blockchain_fields.sql',
      '00003_triggers.sql',
    ]);
    const { files } = parseMigrationFiles(dir);
    const result = validateMigrations(files);
    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0].prefix).toBe(2);
    expect(result.duplicates[0].files).toHaveLength(2);
  });

  it('detects multiple independent duplicate pairs', () => {
    const dir = makeTempMigrationsDir([
      '00012_add_booking_dispute_status.sql',
      '00012_create_property_images_table.sql',
      '00013_add_property_search_vector.sql',
      '00013_update_availability_ranges.sql',
      '00014_add_dynamic_pricing.sql',
      '00014_search_analytics_and_geolocation.sql',
    ]);
    const { files } = parseMigrationFiles(dir);
    const result = validateMigrations(files);
    expect(result.duplicates).toHaveLength(3);
    const prefixes = result.duplicates.map((d) => d.prefix).sort((a, b) => a - b);
    expect(prefixes).toEqual([12, 13, 14]);
  });

  it('reports all files involved in a three-way duplicate', () => {
    const dir = makeTempMigrationsDir([
      '00017_add_amenities_gin_index.sql',
      '00017_add_email_verification.sql',
      '00017_add_geospatial_gist_index.sql',
    ]);
    const { files } = parseMigrationFiles(dir);
    const result = validateMigrations(files);
    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0].files).toHaveLength(3);
  });
});

// ─── validateMigrations — non-monotonic ordering ─────────────────────────────

describe('validateMigrations — non-monotonic ordering detection', () => {
  it('zero-padded filenames always sort correctly — no false positives', () => {
    // Files like 00002 and 00003 always sort correctly when zero-padded.
    // Verify the validator does not emit false positives for a valid ordered set.
    const dir = makeTempMigrationsDir([
      '00001_initial.sql',
      '00002_second.sql',
      '00003_third.sql',
    ]);
    const { files } = parseMigrationFiles(dir);
    const result = validateMigrations(files);
    expect(result.nonMonotonic).toHaveLength(0);
  });
});

// ─── Integration: real migrations directory ───────────────────────────────────

describe('real migrations directory — documents existing duplicates', () => {
  const REAL_DIR = path.resolve(
    fileURLToPath(import.meta.url),
    '../../../database/migrations',
  );

  it('parses all real migration files without throwing', () => {
    if (!fs.existsSync(REAL_DIR)) {
      console.warn(`Skipping: migrations dir not found at ${REAL_DIR}`);
      return;
    }
    expect(() => parseMigrationFiles(REAL_DIR)).not.toThrow();
  });

  it('documents the known duplicate prefixes (2, 13, 14, 17, 20, 21, 28, 32)', () => {
    if (!fs.existsSync(REAL_DIR)) {
      console.warn(`Skipping: migrations dir not found at ${REAL_DIR}`);
      return;
    }

    const { files } = parseMigrationFiles(REAL_DIR);
    const result = validateMigrations(files);
    const dupPrefixes = result.duplicates.map((d) => d.prefix).sort((a, b) => a - b);

    // This is a documentation test — it records the known legacy duplicates.
    // These files are already applied to production and must NOT be renamed.
    // The validate-migrations script prevents NEW duplicates from being added.
    // Note: prefix 12 was resolved — 00012_add_booking_dispute_status.sql was
    // renamed to 00035_add_booking_dispute_status.sql.
    const known = [2, 13, 14, 17, 20, 21, 28, 32];
    for (const p of known) {
      if (!dupPrefixes.includes(p)) {
        console.log(`  Note: prefix ${p} is no longer a duplicate — may have been resolved.`);
      }
    }

    // No new prefixes should be duplicated beyond the known legacy ones
    const unexpected = dupPrefixes.filter((p) => !known.includes(p));
    expect(unexpected).toHaveLength(0);
  });
});
