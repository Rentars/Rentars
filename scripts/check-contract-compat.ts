/**
 * Release gate: ABI + contract version compatibility evidence (#625).
 *
 * Exits non-zero when:
 * - Required ABI JSON files are missing
 * - Rust CONTRACT_VERSION constants disagree with the web minimum
 * - Optional release manifest ABI hashes do not match current files
 *
 * Usage: npx tsx scripts/check-contract-compat.ts
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const ABI_FILES = [
  'apps/contracts/booking_abi.json',
  'apps/contracts/property_listing_abi.json',
  'apps/contracts/review_abi.json',
];

const RUST_VERSION_FILES = [
  'apps/contracts/contracts/booking/src/lib.rs',
  'apps/contracts/contracts/property-listing/src/lib.rs',
  'apps/contracts/contracts/review-contract/src/lib.rs',
  'apps/contracts/contracts/rental-contract/src/lib.rs',
];

const WEB_VERSIONS = 'apps/web/src/lib/contracts/versions.ts';

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function extractRustVersions(): number[] {
  const versions: number[] = [];
  for (const rel of RUST_VERSION_FILES) {
    const abs = resolve(ROOT, rel);
    if (!existsSync(abs)) {
      console.error(`Missing Rust source: ${rel}`);
      process.exit(1);
    }
    const src = readFileSync(abs, 'utf8');
    const match = src.match(/CONTRACT_VERSION:\s*u32\s*=\s*(\d+)/);
    if (!match) {
      console.error(`CONTRACT_VERSION not found in ${rel}`);
      process.exit(1);
    }
    versions.push(Number(match[1]));
  }
  return versions;
}

function extractWebMinVersion(): number {
  const abs = resolve(ROOT, WEB_VERSIONS);
  if (!existsSync(abs)) {
    console.error(`Missing ${WEB_VERSIONS}`);
    process.exit(1);
  }
  const src = readFileSync(abs, 'utf8');
  const match = src.match(/CONTRACT_VERSION_MIN[\s\S]*?\?\?\s*'(\d+)'/);
  if (!match) {
    console.error('Could not parse CONTRACT_VERSION_MIN default');
    process.exit(1);
  }
  return Number(match[1]);
}

function main() {
  console.log('Checking contract ABI + version compatibility…');

  for (const rel of ABI_FILES) {
    const abs = resolve(ROOT, rel);
    if (!existsSync(abs)) {
      console.error(`Missing ABI file: ${rel}`);
      process.exit(1);
    }
    console.log(`  ABI ok  ${rel}  sha256=${sha256(abs).slice(0, 12)}…`);
  }

  const rustVersions = extractRustVersions();
  const webMin = extractWebMinVersion();
  for (const v of rustVersions) {
    if (v < webMin) {
      console.error(`Rust CONTRACT_VERSION ${v} < web minimum ${webMin}`);
      process.exit(1);
    }
  }
  console.log(`  Versions ok  rust=${rustVersions.join(',')}  webMin=${webMin}`);

  const manifestsDir = resolve(ROOT, 'docs/releases');
  if (existsSync(manifestsDir)) {
    const manifests = readdirSync(manifestsDir).filter((f) =>
      /^manifest-.*\.json$/.test(f),
    );
    for (const file of manifests) {
      const manifest = JSON.parse(readFileSync(resolve(manifestsDir, file), 'utf8'));
      const hashes = manifest?.contracts?.abi_sha256;
      if (!hashes || typeof hashes !== 'object') continue;
      for (const [name, expected] of Object.entries(hashes)) {
        const rel = ABI_FILES.find((p) => p.endsWith(`${name}_abi.json`) || p.includes(name));
        if (!rel) continue;
        const actual = sha256(resolve(ROOT, rel));
        if (actual !== expected) {
          console.error(
            `Manifest ${file} abi hash mismatch for ${name}: expected ${expected}, got ${actual}`,
          );
          process.exit(1);
        }
      }
    }
  }

  console.log('contract-compat: PASS');
}

main();
