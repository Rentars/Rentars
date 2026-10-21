#!/usr/bin/env bun
/**
 * check-migration-checksums.ts (#878)
 *
 * Migration files are supposed to be immutable once committed — editing a
 * migration that has already run anywhere silently rewrites history and can
 * desync environments that already applied the old version from ones that
 * apply the edited one. This script detects that drift.
 *
 * It maintains a lock file (apps/backend/database/migrations.lock.json)
 * mapping `filename -> sha256(content)`. On each run it:
 *   1. Loads the lock file (if present).
 *   2. Hashes every current *.sql file in database/migrations/.
 *   3. For any filename present in both: if the hash differs, that is
 *      checksum drift — a migration was edited after being locked in. FAIL.
 *   4. Reports new files (present now, absent from the lock) so they can be
 *      added with `--write`.
 *
 * Usage:
 *   bun run apps/backend/scripts/check-migration-checksums.ts          # check (CI mode)
 *   bun run apps/backend/scripts/check-migration-checksums.ts --write  # (re)write the lock file
 *
 * This is a code-level integrity gate only. It does not apply migrations or
 * touch any real database — see docs for the deployment/rollout steps that
 * require infra access.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '../database/migrations');
const LOCK_FILE = path.resolve(HERE, '../database/migrations.lock.json');
const WRITE = process.argv.includes('--write');

interface LockFile {
  [filename: string]: string; // sha256 hex
}

function hashFile(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

function currentChecksums(): LockFile {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const out: LockFile = {};
  for (const f of files) {
    out[f] = hashFile(path.join(MIGRATIONS_DIR, f));
  }
  return out;
}

function loadLock(): LockFile {
  if (!fs.existsSync(LOCK_FILE)) return {};
  return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')) as LockFile;
}

function main(): void {
  const current = currentChecksums();

  if (WRITE) {
    fs.writeFileSync(LOCK_FILE, JSON.stringify(current, null, 2) + '\n');
    console.log(`Wrote ${Object.keys(current).length} checksum(s) to ${LOCK_FILE}`);
    return;
  }

  const lock = loadLock();
  const drifted: Array<{ file: string; locked: string; actual: string }> = [];
  const newFiles: string[] = [];

  for (const [file, hash] of Object.entries(current)) {
    if (!(file in lock)) {
      newFiles.push(file);
      continue;
    }
    if (lock[file] !== hash) {
      drifted.push({ file, locked: lock[file], actual: hash });
    }
  }

  if (newFiles.length > 0) {
    console.log(`ℹ️  ${newFiles.length} migration file(s) not yet in the checksum lock:`);
    for (const f of newFiles) console.log(`   • ${f}`);
    console.log(
      '   → Run with --write to add them (do this in the same PR that adds the migration).',
    );
  }

  if (drifted.length > 0) {
    console.error(
      `\n❌ Checksum drift detected on ${drifted.length} already-locked migration file(s):`,
    );
    for (const d of drifted) {
      console.error(`   • ${d.file}`);
      console.error(`       locked:   ${d.locked}`);
      console.error(`       actual:   ${d.actual}`);
    }
    console.error(
      '\n   A previously committed migration file was modified. Migrations must be\n' +
        '   forward-only: ship a new migration instead of editing an applied one.\n' +
        '   If this edit is intentional and the migration has never run anywhere,\n' +
        '   re-run with --write to update the lock.\n',
    );
    process.exit(1);
  }

  console.log('✅ No checksum drift detected on locked migration files.');
}

main();
