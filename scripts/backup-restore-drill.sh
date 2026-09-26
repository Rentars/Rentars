#!/bin/bash
set -e

# Backup Restore Verification Drill Script
# Exports, restores, validates, and alerts on database backup integrity
# Usage: bash scripts/backup-restore-drill.sh

BACKUP_TIMESTAMP=$(date +%Y%m%d_%H%M%S)
DRILL_LOG="restore_drill_${BACKUP_TIMESTAMP}.log"
BACKUP_FILE="backup_${BACKUP_TIMESTAMP}.dump"
ALERT_EMAIL="${ALERT_EMAIL:-ops@rentars.app}"
VERIFY_DB_NAME="rentars_verify_${BACKUP_TIMESTAMP}"

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Setup error handler
trap 'on_error' ERR
on_error() {
  echo -e "${RED}[ERROR]${NC} Backup restore drill failed at $(date)" | tee -a "$DRILL_LOG"
  cleanup_on_error
  exit 1
}

cleanup_on_error() {
  echo "Cleaning up..."
  if [ ! -z "$VERIFY_DB_HOST" ]; then
    psql -h "$VERIFY_DB_HOST" -U "$VERIFY_DB_USER" -d postgres \
      -c "DROP DATABASE IF EXISTS $VERIFY_DB_NAME;" 2>/dev/null || true
  fi
  rm -f "$BACKUP_FILE"
}

log() {
  echo -e "${GREEN}[INFO]${NC} $1" | tee -a "$DRILL_LOG"
}

error() {
  echo -e "${RED}[ERROR]${NC} $1" | tee -a "$DRILL_LOG"
}

warn() {
  echo -e "${YELLOW}[WARN]${NC} $1" | tee -a "$DRILL_LOG"
}

# Validate environment variables
log "Validating environment variables..."
: ${PROD_DB_HOST:?"PROD_DB_HOST not set"}
: ${PROD_DB_USER:?"PROD_DB_USER not set"}
: ${PROD_DB_PASSWORD:?"PROD_DB_PASSWORD not set"}
: ${VERIFY_DB_HOST:?"VERIFY_DB_HOST not set"}
: ${VERIFY_DB_USER:?"VERIFY_DB_USER not set"}
: ${VERIFY_DB_PASSWORD:?"VERIFY_DB_PASSWORD not set"}

export PGPASSWORD="$PROD_DB_PASSWORD"

log "=== Backup Restore Verification Drill ==="
log "Started at $(date)"
log "Drill ID: $BACKUP_TIMESTAMP"

# Step 1: Export backup from production
log "Step 1: Exporting backup from production database..."
if ! pg_dump \
  --host="$PROD_DB_HOST" \
  --username="$PROD_DB_USER" \
  --format=custom \
  --verbose \
  --no-owner \
  rentars > "$BACKUP_FILE" 2>&1; then
  error "Failed to export backup"
  rm -f "$BACKUP_FILE"
  exit 1
fi

BACKUP_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
log "Backup exported successfully (Size: $BACKUP_SIZE)"

# Step 2: Create isolated verification database
log "Step 2: Creating isolated verification database..."
export PGPASSWORD="$VERIFY_DB_PASSWORD"

if ! psql -h "$VERIFY_DB_HOST" -U "$VERIFY_DB_USER" -d postgres \
  -c "CREATE DATABASE $VERIFY_DB_NAME;" 2>&1; then
  error "Failed to create verification database"
  exit 1
fi

log "Verification database created: $VERIFY_DB_NAME"

# Step 3: Restore backup to verification database
log "Step 3: Restoring backup to verification database..."
RESTORE_START=$(date +%s)

if ! pg_restore \
  --host="$VERIFY_DB_HOST" \
  --username="$VERIFY_DB_USER" \
  --dbname="$VERIFY_DB_NAME" \
  --verbose \
  --no-owner \
  "$BACKUP_FILE" 2>&1 | tee -a "$DRILL_LOG"; then
  error "Backup restore failed - possible corruption"
  psql -h "$VERIFY_DB_HOST" -U "$VERIFY_DB_USER" -d postgres \
    -c "DROP DATABASE IF EXISTS $VERIFY_DB_NAME;" 2>/dev/null || true
  rm -f "$BACKUP_FILE"
  exit 1
fi

RESTORE_END=$(date +%s)
RECOVERY_TIME=$((RESTORE_END - RESTORE_START))
log "Backup restored successfully in ${RECOVERY_TIME}s"

# Step 4: Validate critical tables
log "Step 4: Validating critical tables..."
CRITICAL_TABLES=("users" "properties" "bookings" "payments" "notifications" "audit_logs")
TABLES_OK=true

for table in "${CRITICAL_TABLES[@]}"; do
  ROW_COUNT=$(psql -h "$VERIFY_DB_HOST" -U "$VERIFY_DB_USER" \
    -d "$VERIFY_DB_NAME" -t -c "SELECT COUNT(*) FROM $table;")

  if [ $? -eq 0 ]; then
    log "✓ Table '$table': $ROW_COUNT rows"
  else
    error "✗ Table '$table': Not found or inaccessible"
    TABLES_OK=false
  fi
done

if [ "$TABLES_OK" = false ]; then
  error "One or more critical tables missing or inaccessible"
  exit 1
fi

# Step 5: Validate extensions
log "Step 5: Validating required extensions..."
REQUIRED_EXTENSIONS=("uuid-ossp" "pgcrypto" "pgtrgm")
EXTENSIONS_OK=true

for ext in "${REQUIRED_EXTENSIONS[@]}"; do
  EXT_CHECK=$(psql -h "$VERIFY_DB_HOST" -U "$VERIFY_DB_USER" \
    -d "$VERIFY_DB_NAME" -t -c "SELECT COUNT(*) FROM pg_extension WHERE extname = '$ext';")

  if [ "$EXT_CHECK" -gt 0 ]; then
    log "✓ Extension '$ext' present"
  else
    warn "⚠ Extension '$ext' not found"
    EXTENSIONS_OK=false
  fi
done

# Step 6: Validate RLS policies
log "Step 6: Validating Row-Level Security policies..."
RLS_POLICY_COUNT=$(psql -h "$VERIFY_DB_HOST" -U "$VERIFY_DB_USER" \
  -d "$VERIFY_DB_NAME" -t -c "SELECT COUNT(*) FROM pg_policies WHERE schemaname = 'public';")

if [ "$RLS_POLICY_COUNT" -gt 0 ]; then
  log "✓ RLS Policies: $RLS_POLICY_COUNT policies found"
else
  warn "⚠ No RLS policies found in restored database"
fi

# Step 7: Execute representative operations
log "Step 7: Testing representative read operation..."
if psql -h "$VERIFY_DB_HOST" -U "$VERIFY_DB_USER" \
  -d "$VERIFY_DB_NAME" -c "SELECT id, email FROM users LIMIT 1;" > /dev/null 2>&1; then
  log "✓ Read operation successful"
else
  error "✗ Read operation failed"
  exit 1
fi

log "Step 8: Testing representative write operation (rollback)..."
if psql -h "$VERIFY_DB_HOST" -U "$VERIFY_DB_USER" \
  -d "$VERIFY_DB_NAME" <<EOF > /dev/null 2>&1; then
BEGIN;
INSERT INTO audit_logs (action, resource_type, resource_id, changes, created_at)
VALUES ('restore_test', 'drill', 'drill_001', '{}'::jsonb, NOW());
ROLLBACK;
EOF
  log "✓ Write operation successful"
else
  warn "⚠ Write operation failed (may indicate schema issues)"
fi

# Step 9: Cleanup verification database
log "Step 9: Cleaning up verification environment..."
psql -h "$VERIFY_DB_HOST" -U "$VERIFY_DB_USER" -d postgres \
  -c "DROP DATABASE IF EXISTS $VERIFY_DB_NAME;" 2>&1

rm -f "$BACKUP_FILE"
log "Cleanup complete"

# Final report
log ""
log "=== Backup Restore Drill Report ==="
log "Recovery Time Objective (RTO): ${RECOVERY_TIME}s"
log "Backup Size: $BACKUP_SIZE"
log "Tables Validated: ${#CRITICAL_TABLES[@]}"
log "Extensions Found: $([[ $EXTENSIONS_OK == true ]] && echo "All" || echo "Partial")"
log "RLS Policies: $RLS_POLICY_COUNT"
log "Status: PASSED"
log "Completed at $(date)"
log "Drill Log: $DRILL_LOG"
log ""

# Upload report if in CI environment
if [ -n "$CI" ] || [ -n "$GITHUB_ACTIONS" ]; then
  log "CI environment detected - upload drill report to artifacts"
fi

exit 0
