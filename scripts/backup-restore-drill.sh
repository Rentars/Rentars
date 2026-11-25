#!/usr/bin/env bash
#
# Backup restore drill (#736).
#
# Exports (or reuses) an encrypted backup, verifies its checksum and archive
# structure, restores it into an isolated database, asserts schema, extension,
# RLS, row-count and referential invariants, records recovery time and backup
# age, and drops the temporary database. A JSON report and the drill log are
# kept in DRILL_REPORT_DIR. The exit status is 0 only when every check passes.
#
# Required environment:
#   BACKUP_ENCRYPTION_KEY                              passphrase for the backup
#   VERIFY_DB_HOST, VERIFY_DB_USER, VERIFY_DB_PASSWORD scratch PostgreSQL instance
#   PROD_DB_HOST, PROD_DB_USER, PROD_DB_PASSWORD        source (sanitized nonprod)
#                                                      unless DRILL_SOURCE_BACKUP is set
#
# Optional environment:
#   PROD_DB_PORT (5432), PROD_DB_NAME (rentars)
#   VERIFY_DB_PORT (5432)
#   DRILL_SOURCE_BACKUP        reuse an encrypted backup instead of exporting one;
#                              expects <path>.sha256 next to it
#   DRILL_BACKUP_OUT           directory that keeps the encrypted backup and checksum
#   DRILL_REPORT_DIR           report directory (default: restore-drill-reports)
#   DRILL_REQUIRED_EXTENSIONS  space-separated extensions (default: "postgis btree_gist")
#   DRILL_RPO_SECONDS          recovery point objective (default: 86400 = 24h); the
#                              drill fails when the backup is older than this
#   DRILL_RTO_SECONDS          recovery time objective (default: 3600 = 1h); the
#                              drill fails when the restore takes longer than this
#   DRILL_EXPECTED_MIGRATION   latest migration name expected in the restored
#                              schema_migrations table (release manifest); when set,
#                              a mismatch fails the drill
#
# Sanitized source requirement: the source database (PROD_DB_* or the database
# captured in DRILL_SOURCE_BACKUP) MUST be a sanitized non-production snapshot.
# Production secrets, credentials and PII must never be present in it, because
# the restored copy lands in the isolated verify instance. This script never
# copies configuration or secret stores into the verify database; only the
# database dump is restored.
#
# Usage: bash scripts/backup-restore-drill.sh

set -Eeuo pipefail

CRITICAL_TABLES=(users properties bookings payments notifications audit_logs)
RLS_TABLES=(bookings payments properties notifications audit_logs)
read -r -a REQUIRED_EXTENSIONS <<<"${DRILL_REQUIRED_EXTENSIONS:-postgis btree_gist}"

PROD_DB_PORT="${PROD_DB_PORT:-5432}"
PROD_DB_NAME="${PROD_DB_NAME:-rentars}"
VERIFY_DB_PORT="${VERIFY_DB_PORT:-5432}"
REPORT_DIR="${DRILL_REPORT_DIR:-restore-drill-reports}"
DRILL_ID="$(date -u +%Y%m%dT%H%M%SZ)"
VERIFY_DB="rentars_verify_$(tr -cd '0-9' <<<"$DRILL_ID")"
WORK_DIR="$(mktemp -d)"
LOG_FILE="$WORK_DIR/drill.log"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
DRILL_STARTED_AT="$(date +%s)"

# Documented recovery objectives. Owners: see docs/operations/backup-restore.md.
RPO_SECONDS="${DRILL_RPO_SECONDS:-86400}"
RTO_SECONDS_TARGET="${DRILL_RTO_SECONDS:-3600}"
EXPECTED_MIGRATION="${DRILL_EXPECTED_MIGRATION:-}"

SOURCE_MODE=""
BACKUP_TAKEN_AT=0
BACKUP_BYTES=0
BACKUP_SHA256=""
RESTORE_STARTED_AT=0
RTO_SECONDS=""
RPO_STATUS="skipped"
RTO_STATUS="skipped"
MIGRATION_STATUS="skipped"
MIGRATION_APPLIED=""
DRILL_DURATION_SECONDS=""
REMEDIATION=()
VERIFY_CREATED=0
FAILURES=0
CHECKS=()
declare -A SRC_COUNT=()

log() {
  printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$LOG_FILE" >&2
}

fatal() {
  log "FATAL: $*"
  exit 1
}

# check <name> <pass|fail|skipped> <detail>
check() {
  CHECKS+=("$1|$2|$3")
  case "$2" in
    fail)
      FAILURES=$((FAILURES + 1))
      log "FAIL  $1: $3"
      ;;
    *)
      log "$(printf '%-7s' "${2^^}") $1: $3"
      ;;
  esac
}

# Records a failed check and stops: nothing after it can be trusted.
abort_check() {
  check "$1" fail "$2"
  fatal "$2"
}

require_env() {
  local name missing=0
  for name in "$@"; do
    if [[ -z "${!name:-}" ]]; then
      log "missing required environment variable: $name"
      missing=1
    fi
  done
  if (( missing )); then
    exit 2
  fi
}

require_tools() {
  local tool missing=()
  for tool in "$@"; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      log "required tool not found: $tool"
      missing+=("$tool")
    fi
  done
  if (( ${#missing[@]} )); then
    fatal "missing required tools: ${missing[*]}"
  fi
}

pg_src() {
  PGPASSWORD="$PROD_DB_PASSWORD" psql --host="$PROD_DB_HOST" --port="$PROD_DB_PORT" \
    --username="$PROD_DB_USER" --dbname="$PROD_DB_NAME" \
    --no-psqlrc -X -q -At -v ON_ERROR_STOP=1 "$@" 2>>"$LOG_FILE"
}

# pg_verify <database> [psql args...]
pg_verify() {
  local db=$1
  shift
  PGPASSWORD="$VERIFY_DB_PASSWORD" psql --host="$VERIFY_DB_HOST" --port="$VERIFY_DB_PORT" \
    --username="$VERIFY_DB_USER" --dbname="$db" \
    --no-psqlrc -X -q -At -v ON_ERROR_STOP=1 "$@" 2>>"$LOG_FILE"
}

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\n'
}

# remediation <note>: records a follow-up action for the operational process.
remediation() {
  REMEDIATION+=("$1")
  log "REMEDIATION: $1"
}

write_report() {
  local rc=$1 status=passed now backup_age=null sep="" entry name state detail
  local rem_sep="" note
  if (( rc != 0 || FAILURES > 0 )); then
    status=failed
  fi
  now="$(date +%s)"
  if (( BACKUP_TAKEN_AT > 0 )); then
    backup_age=$((now - BACKUP_TAKEN_AT))
  fi
  DRILL_DURATION_SECONDS=$((now - DRILL_STARTED_AT))

  mkdir -p "$REPORT_DIR"
  {
    printf '{\n'
    printf '  "drill_id": "%s",\n' "$DRILL_ID"
    printf '  "status": "%s",\n' "$status"
    printf '  "started_at": "%s",\n' "$STARTED_AT"
    printf '  "finished_at": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '  "drill_duration_seconds": %s,\n' "$DRILL_DURATION_SECONDS"
    printf '  "backup": {"source": "%s", "sha256": "%s", "bytes": %s, "taken_at_epoch": %s},\n' \
      "$SOURCE_MODE" "$BACKUP_SHA256" "$BACKUP_BYTES" "$BACKUP_TAKEN_AT"
    printf '  "objectives": {\n'
    printf '    "rpo_seconds": %s, "rpo_status": "%s",\n' "$RPO_SECONDS" "$RPO_STATUS"
    printf '    "rto_seconds": %s, "rto_status": "%s"\n' "$RTO_SECONDS_TARGET" "$RTO_STATUS"
    printf '  },\n'
    printf '  "recovery": {"rto_seconds": %s, "backup_age_seconds": %s},\n' \
      "${RTO_SECONDS:-null}" "$backup_age"
    printf '  "migration": {"expected": "%s", "applied": "%s", "status": "%s"},\n' \
      "$(json_escape "$EXPECTED_MIGRATION")" "$(json_escape "$MIGRATION_APPLIED")" "$MIGRATION_STATUS"
    printf '  "remediation": ['
    for note in "${REMEDIATION[@]}"; do
      printf '%s"%s"' "$rem_sep" "$(json_escape "$note")"
      rem_sep=', '
    done
    printf '],\n'
    printf '  "checks": [\n'
    for entry in "${CHECKS[@]}"; do
      IFS='|' read -r name state detail <<<"$entry"
      printf '%s    {"name": "%s", "status": "%s", "detail": "%s"}' \
        "$sep" "$(json_escape "$name")" "$state" "$(json_escape "$detail")"
      sep=$',\n'
    done
    printf '\n  ]\n}\n'
  } >"$REPORT_FILE"

  cp "$LOG_FILE" "$REPORT_DIR/restore-drill-$DRILL_ID.log" 2>/dev/null || true
}

drop_verify_db() {
  local attempt
  # Terminate any lingering sessions (e.g. from a failed restore) so DROP
  # DATABASE cannot fail with "database is being accessed by other users".
  pg_verify postgres -c "
    SELECT pg_terminate_backend(pid) FROM pg_stat_activity
    WHERE datname = '$VERIFY_DB' AND pid <> pg_backend_pid()" >/dev/null 2>&1 || true
  for attempt in 1 2 3; do
    if pg_verify postgres -c "DROP DATABASE IF EXISTS \"$VERIFY_DB\"" >/dev/null 2>&1; then
      return 0
    fi
    log "DROP DATABASE $VERIFY_DB failed (attempt $attempt); retrying"
    sleep 2
  done
  log "WARNING: could not drop temporary database $VERIFY_DB; remove it manually"
  return 1
}

finish() {
  local rc=$?
  set +e
  if (( VERIFY_CREATED )); then
    if drop_verify_db; then
      log "Dropped temporary database $VERIFY_DB"
    fi
  fi
  write_report "$rc"
  log "Report written to $REPORT_FILE"
  rm -rf "$WORK_DIR"
  if (( rc == 0 && FAILURES > 0 )); then
    rc=1
  fi
  exit "$rc"
}

REPORT_FILE="$REPORT_DIR/restore-drill-$DRILL_ID.json"
trap finish EXIT

use_provided_backup() {
  local src="$DRILL_SOURCE_BACKUP"
  if [[ ! -f "$src" ]]; then
    fatal "DRILL_SOURCE_BACKUP points to a missing file: $src"
  fi
  if [[ ! -f "$src.sha256" ]]; then
    fatal "DRILL_SOURCE_BACKUP requires a checksum manifest next to it: $src.sha256"
  fi
  cp "$src" "$WORK_DIR/backup.dump.enc" || fatal "could not copy $src into the work directory"
  cp "$src.sha256" "$WORK_DIR/backup.dump.enc.sha256" \
    || fatal "could not copy $src.sha256 into the work directory"
  BACKUP_TAKEN_AT="$(stat -c %Y "$src")"
  SOURCE_MODE=provided
  log "Using provided backup $src"
}

export_backup() {
  local dump="$WORK_DIR/backup.dump" t
  SOURCE_MODE=export
  BACKUP_TAKEN_AT="$(date -u +%s)"
  log "Exporting backup from $PROD_DB_HOST:$PROD_DB_PORT/$PROD_DB_NAME"

  # spatial_ref_sys is PostGIS reference data that CREATE EXTENSION populates on
  # install. Restoring its rows over the extension's copy fails on managed
  # databases, so only its structure is captured.
  PGPASSWORD="$PROD_DB_PASSWORD" pg_dump --host="$PROD_DB_HOST" --port="$PROD_DB_PORT" \
    --username="$PROD_DB_USER" --format=custom --no-owner --no-acl \
    --exclude-table-data=spatial_ref_sys \
    --file="$dump" "$PROD_DB_NAME" 2>>"$LOG_FILE" \
    || fatal "pg_dump failed (see drill log)"

  # Source counts are taken from the same database the dump came from, so the
  # restored counts can be compared exactly. The source must be quiescent (the
  # sanitized nonprod snapshot), otherwise writes between dump and count show up
  # as mismatches.
  for t in "${CRITICAL_TABLES[@]}"; do
    SRC_COUNT[$t]="$(pg_src -c "SELECT count(*) FROM public.$t")" \
      || fatal "source table $t is unreadable"
  done

  openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -pass env:BACKUP_ENCRYPTION_KEY \
    -in "$dump" -out "$WORK_DIR/backup.dump.enc" 2>>"$LOG_FILE" \
    || fatal "encryption of the backup failed"
  rm -f "$dump"

  sha256sum "$WORK_DIR/backup.dump.enc" | awk '{print $1}' >"$WORK_DIR/backup.dump.enc.sha256"
  log "Backup encrypted and checksummed"
}

retain_backup() {
  if [[ -z "${DRILL_BACKUP_OUT:-}" ]]; then
    return
  fi
  mkdir -p "$DRILL_BACKUP_OUT"
  cp "$WORK_DIR/backup.dump.enc" "$DRILL_BACKUP_OUT/restore-drill-$DRILL_ID.dump.enc"
  cp "$WORK_DIR/backup.dump.enc.sha256" "$DRILL_BACKUP_OUT/restore-drill-$DRILL_ID.dump.enc.sha256"
  log "Retained encrypted backup in $DRILL_BACKUP_OUT"
}

verify_checksum() {
  local expected actual
  expected="$(awk 'NR == 1 {print $1}' "$WORK_DIR/backup.dump.enc.sha256")"
  if ! actual="$(sha256sum "$WORK_DIR/backup.dump.enc" | awk '{print $1}')"; then
    abort_check backup_checksum "could not compute sha256 of the backup file"
  fi
  BACKUP_SHA256="$actual"
  BACKUP_BYTES="$(stat -c %s "$WORK_DIR/backup.dump.enc")"

  if [[ -z "$expected" ]]; then
    abort_check backup_checksum "checksum manifest is empty or unreadable"
  fi
  if [[ "$expected" != "$actual" ]]; then
    abort_check backup_checksum "sha256 does not match manifest: backup is incomplete or corrupt (expected $expected, got $actual)"
  fi
  check backup_checksum pass "sha256 matches manifest ($BACKUP_BYTES bytes)"
}

decrypt_backup() {
  if ! openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass env:BACKUP_ENCRYPTION_KEY \
    -in "$WORK_DIR/backup.dump.enc" -out "$WORK_DIR/backup.dump" 2>>"$LOG_FILE"; then
    rm -f "$WORK_DIR/backup.dump"
    abort_check backup_decrypt "decryption failed: wrong BACKUP_ENCRYPTION_KEY or corrupt file"
  fi
  check backup_decrypt pass "decrypted with BACKUP_ENCRYPTION_KEY"
}

inspect_archive() {
  local entries
  if ! pg_restore --list "$WORK_DIR/backup.dump" >"$WORK_DIR/toc.txt" 2>>"$LOG_FILE"; then
    abort_check archive_readable "pg_restore cannot read the archive table of contents"
  fi
  entries="$(grep -c ' TABLE ' "$WORK_DIR/toc.txt" || true)"
  check archive_readable pass "archive lists $entries table definitions"
}

create_verify_db() {
  # A leftover database from a previous aborted run would make CREATE fail.
  pg_verify postgres -c "DROP DATABASE IF EXISTS \"$VERIFY_DB\"" >/dev/null 2>&1 || true
  if ! pg_verify postgres -c "CREATE DATABASE \"$VERIFY_DB\"" >/dev/null; then
    fatal "could not create temporary database $VERIFY_DB on $VERIFY_DB_HOST:$VERIFY_DB_PORT"
  fi
  VERIFY_CREATED=1
  log "Created temporary database $VERIFY_DB"
}

restore_backup() {
  RESTORE_STARTED_AT="$(date +%s)"
  if ! PGPASSWORD="$VERIFY_DB_PASSWORD" pg_restore --host="$VERIFY_DB_HOST" \
    --port="$VERIFY_DB_PORT" --username="$VERIFY_DB_USER" --dbname="$VERIFY_DB" \
    --no-owner --no-acl --exit-on-error "$WORK_DIR/backup.dump" >>"$LOG_FILE" 2>&1; then
    abort_check restore "pg_restore --exit-on-error failed (see drill log)"
  fi
  rm -f "$WORK_DIR/backup.dump"
  check restore pass "restored into $VERIFY_DB"
}

validate_restore() {
  local t count ext n rls policies orphans inserted remaining

  for t in "${CRITICAL_TABLES[@]}"; do
    if ! count="$(pg_verify "$VERIFY_DB" -c "SELECT count(*) FROM public.$t")"; then
      check "rows:$t" fail "table missing or unreadable after restore"
      continue
    fi
    if [[ -n "${SRC_COUNT[$t]:-}" ]]; then
      if [[ "$count" == "${SRC_COUNT[$t]}" ]]; then
        check "rows:$t" pass "$count rows match source"
      else
        check "rows:$t" fail "restored $count rows, source had ${SRC_COUNT[$t]}"
      fi
    else
      check "rows:$t" skipped "$count rows restored; no source to compare"
    fi
  done

  for ext in "${REQUIRED_EXTENSIONS[@]}"; do
    n="$(pg_verify "$VERIFY_DB" -c "SELECT count(*) FROM pg_extension WHERE extname = '$ext'")"
    if [[ "$n" == 1 ]]; then
      check "extension:$ext" pass "installed"
    else
      check "extension:$ext" fail "not installed after restore"
    fi
  done

  for t in "${RLS_TABLES[@]}"; do
    rls="$(pg_verify "$VERIFY_DB" -c "SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.$t')")"
    if [[ "$rls" == "t" ]]; then
      check "rls:$t" pass "row level security enabled"
    else
      check "rls:$t" fail "row level security missing or table absent"
    fi
  done

  policies="$(pg_verify "$VERIFY_DB" -c "SELECT count(*) FROM pg_policies WHERE schemaname = 'public'")"
  if (( policies > 0 )); then
    check rls_policies pass "$policies policies in public schema"
  else
    check rls_policies fail "no RLS policies in public schema"
  fi

  orphans="$(pg_verify "$VERIFY_DB" -c "
    SELECT (SELECT count(*) FROM payments p WHERE NOT EXISTS (SELECT 1 FROM bookings b WHERE b.id = p.booking_id))
         + (SELECT count(*) FROM bookings b WHERE NOT EXISTS (SELECT 1 FROM properties pr WHERE pr.id = b.property_id))")"
  if [[ "$orphans" == 0 ]]; then
    check references pass "no orphaned payments or bookings"
  else
    check references fail "$orphans orphaned payment or booking rows"
  fi

  # Explicit booking/payment integrity queries beyond the aggregate reference
  # check, so a failure names the broken relationship.
  local orphan_payments orphan_bookings escrow_mismatch
  orphan_payments="$(pg_verify "$VERIFY_DB" -c "
    SELECT count(*) FROM payments p
    WHERE NOT EXISTS (SELECT 1 FROM bookings b WHERE b.id = p.booking_id)")"
  if [[ "$orphan_payments" == 0 ]]; then
    check integrity:orphan_payments pass "every payment references an existing booking"
  else
    check integrity:orphan_payments fail "$orphan_payments payments reference a missing booking"
    remediation "Investigate $orphan_payments orphaned payment rows; check FK constraints on payments.booking_id."
  fi

  orphan_bookings="$(pg_verify "$VERIFY_DB" -c "
    SELECT count(*) FROM bookings b
    WHERE NOT EXISTS (SELECT 1 FROM properties pr WHERE pr.id = b.property_id)")"
  if [[ "$orphan_bookings" == 0 ]]; then
    check integrity:orphan_bookings pass "every booking references an existing property"
  else
    check integrity:orphan_bookings fail "$orphan_bookings bookings reference a missing property"
    remediation "Investigate $orphan_bookings bookings without a property; check FK constraints on bookings.property_id."
  fi

  # Escrow state consistency: a booking marked as paid must have at least one
  # completed payment, and a completed payment must belong to a paid booking.
  escrow_mismatch="$(pg_verify "$VERIFY_DB" -c "
    SELECT (SELECT count(*) FROM bookings b
              WHERE b.status = 'paid'
                AND NOT EXISTS (SELECT 1 FROM payments p
                                WHERE p.booking_id = b.id AND p.status = 'completed'))
         + (SELECT count(*) FROM payments p
              JOIN bookings b ON b.id = p.booking_id
             WHERE p.status = 'completed' AND b.status <> 'paid')")"
  if [[ "$escrow_mismatch" == 0 ]]; then
    check integrity:escrow_state pass "booking and payment states are consistent"
  else
    check integrity:escrow_state fail "$escrow_mismatch booking/payment state mismatches"
    remediation "Reconcile $escrow_mismatch booking/payment state mismatches before relying on this backup."
  fi

  if pg_verify "$VERIFY_DB" -c "SELECT id, email FROM users LIMIT 1" >/dev/null; then
    check read_probe pass "user read succeeded"
  else
    check read_probe fail "user read failed"
  fi

  # Write probe: insert an audit row, prove it is visible inside the
  # transaction, roll back, then confirm no probe row survived.
  inserted="$(pg_verify "$VERIFY_DB" 2>>"$LOG_FILE" <<'SQL' | tail -n 1
BEGIN;
WITH ins AS (
  INSERT INTO audit_logs (actor_id, action, target_type, metadata)
  SELECT id, 'restore_drill.write_probe', 'restore_drill', '{}'::jsonb FROM users LIMIT 1
  RETURNING 1
)
SELECT count(*) FROM ins;
ROLLBACK;
SQL
)"
  remaining="$(pg_verify "$VERIFY_DB" -c "SELECT count(*) FROM audit_logs WHERE action = 'restore_drill.write_probe'")"
  if [[ "$inserted" == 1 && "$remaining" == 0 ]]; then
    check write_probe pass "audit insert accepted and rolled back"
  else
    check write_probe fail "insert returned '$inserted', probe rows left after rollback: '$remaining'"
  fi

  RTO_SECONDS=$(( $(date +%s) - RESTORE_STARTED_AT ))
}

verify_migration() {
  local applied
  if ! applied="$(pg_verify "$VERIFY_DB" -c "
    SELECT version FROM public.schema_migrations ORDER BY version DESC LIMIT 1" 2>/dev/null)"; then
    MIGRATION_STATUS=fail
    check migration_compatibility fail "schema_migrations table missing or unreadable after restore"
    remediation "Ensure the backup includes the schema_migrations table so migration state can be verified."
    return
  fi
  MIGRATION_APPLIED="$applied"
  if [[ -z "$EXPECTED_MIGRATION" ]]; then
    MIGRATION_STATUS=skipped
    check migration_compatibility skipped "latest applied migration '$applied'; no DRILL_EXPECTED_MIGRATION set"
    return
  fi
  if [[ "$applied" == "$EXPECTED_MIGRATION" ]]; then
    MIGRATION_STATUS=pass
    check migration_compatibility pass "latest applied migration matches release manifest ($applied)"
  else
    MIGRATION_STATUS=fail
    check migration_compatibility fail "latest applied migration '$applied' != expected '$EXPECTED_MIGRATION'"
    remediation "Backup migration state '$applied' does not match release '$EXPECTED_MIGRATION'; re-export from a migrated source."
  fi
}

verify_objectives() {
  local now backup_age
  now="$(date +%s)"

  if (( BACKUP_TAKEN_AT > 0 )); then
    backup_age=$((now - BACKUP_TAKEN_AT))
    if (( backup_age <= RPO_SECONDS )); then
      RPO_STATUS=pass
      check rpo pass "backup age ${backup_age}s within RPO ${RPO_SECONDS}s"
    else
      RPO_STATUS=fail
      check rpo fail "backup age ${backup_age}s exceeds RPO ${RPO_SECONDS}s"
      remediation "Backup is older than the RPO; increase backup frequency or fix the backup schedule."
    fi
  else
    RPO_STATUS=skipped
    check rpo skipped "backup timestamp unknown"
  fi

  if [[ -n "$RTO_SECONDS" ]]; then
    if (( RTO_SECONDS <= RTO_SECONDS_TARGET )); then
      RTO_STATUS=pass
      check rto pass "restore took ${RTO_SECONDS}s within RTO ${RTO_SECONDS_TARGET}s"
    else
      RTO_STATUS=fail
      check rto fail "restore took ${RTO_SECONDS}s, exceeds RTO ${RTO_SECONDS_TARGET}s"
      remediation "Restore exceeded the RTO; investigate restore throughput and verify instance sizing."
    fi
  else
    RTO_STATUS=skipped
    check rto skipped "restore duration not measured"
  fi
}

main() {
  require_env BACKUP_ENCRYPTION_KEY VERIFY_DB_HOST VERIFY_DB_USER VERIFY_DB_PASSWORD
  if [[ -z "${DRILL_SOURCE_BACKUP:-}" ]]; then
    require_env PROD_DB_HOST PROD_DB_USER PROD_DB_PASSWORD
    require_tools pg_dump
  fi
  require_tools psql pg_restore openssl sha256sum awk sed stat mktemp

  log "=== Backup restore drill $DRILL_ID ==="
  if [[ -n "${DRILL_SOURCE_BACKUP:-}" ]]; then
    use_provided_backup
  else
    export_backup
  fi
  retain_backup
  verify_checksum
  decrypt_backup
  inspect_archive
  create_verify_db
  restore_backup
  validate_restore
  verify_migration
  verify_objectives

  if (( FAILURES > 0 )); then
    fatal "$FAILURES check(s) failed"
  fi
  log "Drill passed: RTO ${RTO_SECONDS}s (target ${RTO_SECONDS_TARGET}s), backup age $(( $(date +%s) - BACKUP_TAKEN_AT ))s (RPO ${RPO_SECONDS}s)"
}

main "$@"
#!/usr/bin/env bash
# Validates that the runtime versions in use meet the project's minimum
# requirements.  Called by the `engines:check` npm script and the CI
# runtime-check job.  Exits 1 on the first unsupported version and prints
# a human-readable error with the actual vs required version.
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

ERRORS=0

fail() {
  echo -e "${RED}✗ $1${NC}" >&2
  ERRORS=$((ERRORS + 1))
}

pass() {
  echo -e "${GREEN}✓ $1${NC}"
}

# Compare semver components (major.minor.patch).  Returns 0 when $1 >= $2.
version_gte() {
  local actual="$1" required="$2"
  printf '%s\n%s\n' "$required" "$actual" | sort -V -C
}

# ── Node ────────────────────────────────────────────────────────────────────
REQUIRED_NODE="20.0.0"
if command -v node &>/dev/null; then
  NODE_VERSION=$(node --version | tr -d 'v')
  if version_gte "$NODE_VERSION" "$REQUIRED_NODE"; then
    pass "Node $NODE_VERSION (required >= $REQUIRED_NODE)"
  else
    fail "Node $NODE_VERSION is too old — required >= $REQUIRED_NODE"
  fi
else
  fail "Node not found — required >= $REQUIRED_NODE"
fi

# ── Yarn ────────────────────────────────────────────────────────────────────
REQUIRED_YARN="1.22.0"
if command -v yarn &>/dev/null; then
  YARN_VERSION=$(yarn --version 2>/dev/null)
  if version_gte "$YARN_VERSION" "$REQUIRED_YARN"; then
    pass "Yarn $YARN_VERSION (required >= $REQUIRED_YARN)"
  else
    fail "Yarn $YARN_VERSION is too old — required >= $REQUIRED_YARN"
  fi
else
  fail "Yarn not found — required >= $REQUIRED_YARN"
fi

# ── Bun ─────────────────────────────────────────────────────────────────────
REQUIRED_BUN="1.1.0"
if command -v bun &>/dev/null; then
  BUN_VERSION=$(bun --version 2>/dev/null)
  if version_gte "$BUN_VERSION" "$REQUIRED_BUN"; then
    pass "Bun $BUN_VERSION (required >= $REQUIRED_BUN)"
  else
    fail "Bun $BUN_VERSION is too old — required >= $REQUIRED_BUN"
  fi
else
  echo "  Bun not found — skipping (only required for backend workspace)"
fi

# ── Rust ────────────────────────────────────────────────────────────────────
REQUIRED_RUST="1.82.0"
if command -v rustc &>/dev/null; then
  RUST_VERSION=$(rustc --version | awk '{print $2}')
  if version_gte "$RUST_VERSION" "$REQUIRED_RUST"; then
    pass "Rust $RUST_VERSION (required >= $REQUIRED_RUST)"
  else
    fail "Rust $RUST_VERSION is too old — required >= $REQUIRED_RUST"
  fi
else
  echo "  Rust not found — skipping (only required for contracts workspace)"
fi

if [[ $ERRORS -gt 0 ]]; then
  echo ""
  echo -e "${RED}Engine check failed: $ERRORS unsupported runtime(s).${NC}" >&2
  echo "Update your runtime(s) or use a version manager (.tool-versions / .nvmrc)." >&2
  exit 1
fi

echo ""
echo "All engine checks passed."
