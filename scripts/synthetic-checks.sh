#!/usr/bin/env bash
# Read-only synthetic production checks. Never mutates data or moves funds.
# See docs/synthetic-monitoring.md for the probe definitions and alert rules.
set -u

BASE_URL="${BASE_URL:-http://localhost:3000}"
WEB_URL="${WEB_URL:-http://localhost:3001}"
# Deployment gate mode: "preflight" (before traffic shift) or "postdeploy" (after traffic shift).
# Any required check failure makes the script exit non-zero so CI can block promotion.
GATE_MODE="${GATE_MODE:-postdeploy}"
# Payment checks are only allowed against mocked/testnet payment configuration.
PAYMENT_MODE="${PAYMENT_MODE:-mock}"
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

# Emit a machine-readable deployment record line linking version, migration state and health.
record() {
  echo "RECORD gate=$GATE_MODE version=${APP_VERSION:-unknown} migration=${MIGRATION_STATE:-unknown} health=$1"
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

# 6. API readiness (distinct from liveness: verifies dependencies are reachable)
ready=$(curl -s --max-time 10 "$BASE_URL/ready" || echo "")
if echo "$ready" | grep -qE '"status"[[:space:]]*:[[:space:]]*"(ok|ready|up)"'; then
  pass readiness "api ready"
else
  fail readiness readiness "no ready status in /ready"
fi

# 7. Database compatibility (read-only; reports schema/migration state, never migrates)
dbstate=$(curl -s --max-time 10 "$BASE_URL/health/db" || echo "")
if echo "$dbstate" | grep -qE '"status"[[:space:]]*:[[:space:]]*"(ok|up)"'; then
  mig=$(echo "$dbstate" | sed -n 's/.*"migration"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  pass database "db compatible migration=${mig:-unknown}"
  MIGRATION_STATE="${mig:-unknown}"
else
  fail database database "db compatibility check failed"
fi

# 8. Payment configuration (mocked/testnet only; never creates bookings or moves funds)
if [ "$PAYMENT_MODE" = "mock" ] || [ "$PAYMENT_MODE" = "testnet" ]; then
  pay=$(curl -s --max-time 10 "$BASE_URL/health/payments" || echo "")
  pmode=$(echo "$pay" | sed -n 's/.*"mode"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  if [ "$pmode" = "mock" ] || [ "$pmode" = "testnet" ]; then
    pass payments "payment config mode=$pmode (no funds moved)"
  else
    fail payments payments "payment mode '${pmode:-unknown}' not mock/testnet"
  fi
else
  fail payments payments "PAYMENT_MODE=$PAYMENT_MODE not allowed for synthetic checks"
fi

# Deployment record: link version, migration state and overall health result.
if [ "$FAILURES" -eq 0 ]; then
  record "pass"
else
  record "fail"
fi

# Promotion gate: any required check failure blocks promotion / triggers rollback.
if [ "$FAILURES" -ne 0 ]; then
  echo "GATE BLOCKED gate=$GATE_MODE failures=$FAILURES — do not promote traffic; follow rollback runbook."
fi

exit "$FAILURES"
