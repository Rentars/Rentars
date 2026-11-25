#!/usr/bin/env bash
#
# check-resource-budgets.sh
#
# Runs the Soroban resource measurement tests for the booking and property
# contracts, parses the emitted RESOURCE_METRIC lines, and compares each
# measured value against the configured budget in resource-budgets.json.
#
# Exits non-zero with a clear per-metric diff when a budget (plus tolerance)
# is exceeded. Runnable locally and in CI without production credentials.
#
# Usage:
#   ./scripts/check-resource-budgets.sh [--update-baseline]
#
# Environment:
#   RESOURCE_BUDGETS_FILE  Override path to budgets JSON (default: ../resource-budgets.json)
#   RESOURCE_TEST_FILTER   Cargo test filter (default: resource_)
#   CARGO                  Cargo binary (default: cargo)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

BUDGETS_FILE="${RESOURCE_BUDGETS_FILE:-${CONTRACT_DIR}/resource-budgets.json}"
TEST_FILTER="${RESOURCE_TEST_FILTER:-resource_}"
CARGO_BIN="${CARGO:-cargo}"

UPDATE_BASELINE=0
for arg in "$@"; do
  case "${arg}" in
    --update-baseline) UPDATE_BASELINE=1 ;;
    -h|--help)
      sed -n '2,20p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      echo "Unknown argument: ${arg}" >&2
      exit 2
      ;;
  esac
done

if [[ ! -f "${BUDGETS_FILE}" ]]; then
  echo "ERROR: budgets file not found: ${BUDGETS_FILE}" >&2
  exit 2
fi

if ! command -v "${CARGO_BIN}" >/dev/null 2>&1; then
  echo "ERROR: cargo not found (looked for '${CARGO_BIN}')." >&2
  exit 2
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required to parse budgets and metrics." >&2
  exit 2
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT

RAW_LOG="${WORK_DIR}/resource-tests.log"
METRICS_FILE="${WORK_DIR}/metrics.tsv"

echo "==> Running resource measurement tests (filter: '${TEST_FILTER}')"
echo "    contract dir: ${CONTRACT_DIR}"
echo "    budgets file: ${BUDGETS_FILE}"

set +e
(
  cd "${CONTRACT_DIR}"
  "${CARGO_BIN}" test --release -- --nocapture --test-threads=1 "${TEST_FILTER}"
) 2>&1 | tee "${RAW_LOG}"
TEST_STATUS=${PIPESTATUS[0]}
set -e

if [[ ${TEST_STATUS} -ne 0 ]]; then
  echo "" >&2
  echo "ERROR: resource measurement tests failed (exit ${TEST_STATUS})." >&2
  echo "       See output above for details." >&2
  exit "${TEST_STATUS}"
fi

# Parse RESOURCE_METRIC lines. Expected format:
#   RESOURCE_METRIC <operation> <metric> <value>
# e.g.
#   RESOURCE_METRIC create_booking cpu_instructions 1234567
#   RESOURCE_METRIC create_booking memory_bytes 4096
#   RESOURCE_METRIC create_booking ledger_entries 3
grep -E '^RESOURCE_METRIC[[:space:]]' "${RAW_LOG}" \
  | awk '{ if (NF < 4) { print "MALFORMED: " $0 > "/dev/stderr"; next } print $2 "\t" $3 "\t" $4 }' \
  > "${METRICS_FILE}" || true

if [[ ! -s "${METRICS_FILE}" ]]; then
  echo "" >&2
  echo "ERROR: no RESOURCE_METRIC lines were emitted by the tests." >&2
  echo "       Ensure the resource tests are enabled and print metrics." >&2
  exit 1
fi

echo ""
echo "==> Parsed $(wc -l < "${METRICS_FILE}" | tr -d ' ') resource metric(s)"

if [[ ${UPDATE_BASELINE} -eq 1 ]]; then
  echo "==> Updating baseline budgets file: ${BUDGETS_FILE}"
  # Build a new budgets object from the measured metrics, preserving tolerance
  # and any existing metadata where possible.
  jq -Rn \
    --slurpfile existing "${BUDGETS_FILE}" \
    '
    [inputs | select(length > 0) | split("\t") | {operation: .[0], metric: .[1], value: (.[2] | tonumber)}]
    | reduce .[] as $m ({};
        .[$m.operation] = ((.[$m.operation] // {}) + {($m.metric): $m.value})
      )
    | {
        tolerance: ($existing[0].tolerance // 0.10),
        budgets: .
      }
    ' < "${METRICS_FILE}" > "${BUDGETS_FILE}.tmp"
  mv "${BUDGETS_FILE}.tmp" "${BUDGETS_FILE}"
  echo "==> Baseline updated. Review and commit the change with a note explaining it."
  exit 0
fi

TOLERANCE="$(jq -r '.tolerance // 0.10' "${BUDGETS_FILE}")"

echo "==> Comparing against budgets (tolerance: ${TOLERANCE})"
echo ""

FAILURES=0
CHECKED=0

while IFS=$'\t' read -r operation metric value; do
  [[ -z "${operation}" || -z "${metric}" || -z "${value}" ]] && continue

  budget="$(jq -r --arg op "${operation}" --arg m "${metric}" \
    '.budgets[$op][$m] // empty' "${BUDGETS_FILE}")"

  if [[ -z "${budget}" || "${budget}" == "null" ]]; then
    echo "  MISSING BUDGET  ${operation}.${metric} = ${value} (no budget configured)"
    FAILURES=$((FAILURES + 1))
    continue
  fi

  # Compute allowed maximum = budget * (1 + tolerance)
  allowed="$(awk -v b="${budget}" -v t="${TOLERANCE}" 'BEGIN { printf "%.0f", b * (1 + t) }')"

  CHECKED=$((CHECKED + 1))

  if awk -v v="${value}" -v a="${allowed}" 'BEGIN { exit !(v > a) }'; then
    over="$(awk -v v="${value}" -v a="${allowed}" 'BEGIN { printf "%.2f", ((v - a) / a) * 100 }')"
    echo "  FAIL  ${operation}.${metric}"
    echo "        measured: ${value}"
    echo "        budget:   ${budget} (allowed max with tolerance: ${allowed})"
    echo "        over by:  ${over}%"
    FAILURES=$((FAILURES + 1))
  else
    headroom="$(awk -v v="${value}" -v a="${allowed}" 'BEGIN { printf "%.1f", ((a - v) / a) * 100 }')"
    echo "  ok    ${operation}.${metric} = ${value} (budget ${budget}, headroom ${headroom}%)"
  fi
done < "${METRICS_FILE}"

echo ""
if [[ ${FAILURES} -gt 0 ]]; then
  echo "ERROR: ${FAILURES} resource budget check(s) failed out of ${CHECKED} checked." >&2
  echo "       If the increase is intentional, update ${BUDGETS_FILE}" >&2
  echo "       and document the reason in the PR description." >&2
  exit 1
fi

echo "==> All ${CHECKED} resource budget check(s) passed."
exit 0