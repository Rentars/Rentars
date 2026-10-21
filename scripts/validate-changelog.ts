#!/usr/bin/env bun
/**
 * Validates that CHANGELOG.md is well-formed before a release.
 *
 * Rules enforced:
 *   1. An [Unreleased] section must exist.
 *   2. Every entry under [Unreleased] must carry at least one recognised
 *      category heading (### Added | Changed | Deprecated | Removed | Fixed |
 *      Security | Performance).
 *   3. Any version section (e.g. [1.2.3]) must include a release date in the
 *      heading (e.g. [1.2.3] - 2026-09-25).
 *
 * Exits 0 on success, 1 on validation failures.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CHANGELOG_PATH = resolve(process.cwd(), 'CHANGELOG.md');
const VALID_CATEGORIES = new Set([
  'Added',
  'Changed',
  'Deprecated',
  'Removed',
  'Fixed',
  'Security',
  'Performance',
]);

let errors: string[] = [];

function fail(msg: string) {
  errors.push(`  ✗ ${msg}`);
}

const content = readFileSync(CHANGELOG_PATH, 'utf-8');
const lines = content.split('\n');

// ── Rule 1: [Unreleased] section must exist ──────────────────────────────────
if (!lines.some((l) => /^##\s+\[Unreleased\]/i.test(l))) {
  fail('Missing ## [Unreleased] section');
}

// ── Rule 2: [Unreleased] section must have at least one recognised category ──
const unreleasedStart = lines.findIndex((l) => /^##\s+\[Unreleased\]/i.test(l));
if (unreleasedStart >= 0) {
  // Find end of the Unreleased section (next ## heading or EOF)
  const unreleasedEnd = lines.findIndex(
    (l, i) => i > unreleasedStart && /^##\s+\[/.test(l)
  );
  const section = lines.slice(
    unreleasedStart + 1,
    unreleasedEnd === -1 ? undefined : unreleasedEnd
  );
  const hasCategory = section.some((l) => {
    const m = l.match(/^###\s+(\w+)/);
    return m && VALID_CATEGORIES.has(m[1]);
  });
  if (!hasCategory) {
    fail(
      `[Unreleased] section has no recognised category heading. ` +
        `Add at least one of: ${[...VALID_CATEGORIES].join(', ')}.`
    );
  }
}

// ── Rule 3: Version sections must include a date ─────────────────────────────
const versionLines = lines.filter((l) =>
  /^##\s+\[\d+\.\d+\.\d+\]/.test(l)
);
for (const line of versionLines) {
  if (!/^##\s+\[\d+\.\d+\.\d+\]\s+-\s+\d{4}-\d{2}-\d{2}/.test(line)) {
    fail(`Version heading is missing a release date: ${line.trim()}`);
  }
}

// ── Report ───────────────────────────────────────────────────────────────────
if (errors.length > 0) {
  console.error('CHANGELOG.md validation failed:\n');
  for (const e of errors) console.error(e);
  console.error('');
  process.exit(1);
}

console.log('CHANGELOG.md validation passed.');
#!/usr/bin/env bash
# Read-only synthetic production checks. Never mutates data or moves funds.
# See docs/synthetic-monitoring.md for the probe definitions and alert rules.
set -u

BASE_URL="${BASE_URL:-http://localhost:3000}"
WEB_URL="${WEB_URL:-http://localhost:3001}"
FAILURES=0

redact() {
  sed -E 's/("password"|"token"|"secret"|Bearer )[[:space:]]*[^,}]*/\1 ***REDACTED***/Ig'
}

fail() {
  echo "FAIL [$1] step=$2 $3" | redact
  FAILURES=$((FAILURES + 1))
}

pass() {
  echo "PASS [$1] $2"
}

# 1. Frontend site
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$WEB_URL/" || echo 000)
if [ "$code" = "200" ]; then pass site "frontend HTTP 200"; else fail site frontend "HTTP $code"; fi

# 2. API health
health=$(curl -s --max-time 10 "$BASE_URL/health" || echo "")
if echo "$health" | grep -q '"status"'; then
  pass health "api healthy version=$(echo "$health" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
else
  fail health api "no status in /health"
fi

# 3. CORS preflight
acao=$(curl -s -o /dev/null -D - -X OPTIONS --max-time 10 \
  -H "Origin: https://example.com" \
  -H "Access-Control-Request-Method: GET" \
  "$BASE_URL/api/v1/properties/search/advanced" 2>/dev/null \
  | grep -i '^access-control-allow-origin' | head -1 || true)
if [ -n "$acao" ]; then pass cors "allow-origin header present"; else fail cors cors "missing allow-origin"; fi

# 4. Auth round-trip (read-only; canary credentials from env, redacted in logs)
if [ -n "${SYNTHETIC_CANARY_EMAIL:-}" ] && [ -n "${SYNTHETIC_CANARY_PASSWORD:-}" ]; then
  login=$(curl -s --max-time 10 -X POST "$BASE_URL/api/v1/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$SYNTHETIC_CANARY_EMAIL\",\"password\":\"$SYNTHETIC_CANARY_PASSWORD\"}" || echo "")
  token=$(echo "$login" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  if [ -n "$token" ]; then
    pcode=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
      -H "Authorization: Bearer $token" "$BASE_URL/api/v1/profile" || echo 000)
    if [ "$pcode" = "200" ]; then pass auth "login + profile 200"; else fail auth auth "profile HTTP $pcode"; fi
  else
    fail auth auth "login returned no token"
  fi
  # Invalid token must be rejected
  icode=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
    -H "Authorization: Bearer invalid-token" "$BASE_URL/api/v1/profile" || echo 000)
  if [ "$icode" = "401" ] || [ "$icode" = "403" ]; then pass auth "invalid token rejected ($icode)"; else fail auth auth "invalid token got HTTP $icode"; fi
else
  echo "SKIP [auth] SYNTHETIC_CANARY_EMAIL/PASSWORD not set"
fi

# 5. Search (read-only)
t0=$(date +%s%N)
scode=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
  "$BASE_URL/api/v1/properties/search/advanced?q=berlin" || echo 000)
t1=$(date +%s%N)
ms=$(( (t1 - t0) / 1000000 ))
if [ "$scode" = "200" ] && [ "$ms" -lt 2000 ]; then
  pass search "HTTP 200 in ${ms}ms"
else
  fail search search "HTTP $scode in ${ms}ms"
fi

exit "$FAILURES"
