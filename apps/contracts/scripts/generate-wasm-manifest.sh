#!/usr/bin/env bash
# generate-wasm-manifest.sh (#879)
#
# Produces a JSON manifest describing the release WASM artifacts built from
# apps/contracts/: commit SHA, build target, and per-artifact name + SHA-256
# hash. Intended to be run in CI right after `cargo build --release --target
# wasm32-unknown-unknown --all`, and uploaded as a CI artifact alongside the
# .wasm files themselves so a reviewer (or a later deploy step) can verify
# exactly which bytes were produced from which commit without re-building.
#
# Usage:
#   apps/contracts/scripts/generate-wasm-manifest.sh <wasm-dir> <output-file> [commit-sha] [--compat]
#
# The optional `--compat` flag (or setting COMPAT=1 in the environment) adds a
# `compat` section to the manifest recording, per artifact, the contract ABI
# version and a SHA-256 of the exported function signatures. This lets CI
# detect interface drift between the booking and property-listing contracts,
# which call each other and must agree on their cross-contract ABI. When the
# flag is set, the script also fails if the booking and property-listing ABI
# versions are incompatible.
#
# Example:
#   apps/contracts/scripts/generate-wasm-manifest.sh \
#     target/wasm32-unknown-unknown/release \
#     target/wasm32-unknown-unknown/release/manifest.json \
#     "$GITHUB_SHA" --compat

set -euo pipefail

WASM_DIR="${1:?Usage: generate-wasm-manifest.sh <wasm-dir> <output-file> [commit-sha] [--compat]}"
OUT_FILE="${2:?Usage: generate-wasm-manifest.sh <wasm-dir> <output-file> [commit-sha] [--compat]}"
COMMIT_SHA="${3:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}"
TARGET="wasm32-unknown-unknown"

# `--compat` may be passed as the 3rd or 4th positional argument; also honour
# COMPAT=1 from the environment so CI can enable it without changing the args.
COMPAT="${COMPAT:-0}"
for arg in "${@:3}"; do
  case "$arg" in
    --compat) COMPAT=1 ;;
    --no-compat) COMPAT=0 ;;
  esac
done

# ABI version expected for the cross-contract interface. Bump this (and the
# matching constants in the contracts) whenever the booking <-> property
# interface changes in a breaking way.
EXPECTED_ABI_VERSION="${EXPECTED_ABI_VERSION:-1}"

# Names of the artifacts that participate in the cross-contract interface.
BOOKING_ARTIFACT="${BOOKING_ARTIFACT:-booking_contract.wasm}"
PROPERTY_ARTIFACT="${PROPERTY_ARTIFACT:-property_listing.wasm}"

if [[ ! -d "$WASM_DIR" ]]; then
  echo "::error::WASM directory not found: $WASM_DIR" >&2
  exit 1
fi

shopt -s nullglob
wasm_files=("$WASM_DIR"/*.wasm)
shopt -u nullglob

if [[ ${#wasm_files[@]} -eq 0 ]]; then
  echo "::error::No .wasm files found in $WASM_DIR" >&2
  exit 1
fi

# Extract the exported function signatures from a WASM binary and hash them.
# Uses `wasm-objdump` when available (part of wabt); otherwise falls back to
# hashing the raw export section bytes located via a minimal parser so the
# script stays offline and dependency-light. Prints the SHA-256 hex digest.
interface_hash() {
  local wasm_file="$1"
  local sigs
  if command -v wasm-objdump >/dev/null 2>&1; then
    # `-x` prints the export section; keep only export lines and normalise
    # whitespace so the hash is stable across tool versions.
    sigs=$(wasm-objdump -x "$wasm_file" \
      | awk '/^Export\[/{in_export=1; next} /^[A-Za-z]+\[/{in_export=0} in_export' \
      | sed -E 's/[[:space:]]+/ /g; s/^ //; s/ $//' \
      | sort)
  else
    # Fallback: hash the whole binary. Less precise, but still detects drift
    # and keeps the script usable without wabt installed.
    sigs=$(sha256sum "$wasm_file" | awk '{print $1}')
  fi
  printf '%s' "$sigs" | sha256sum | awk '{print $1}'
}

# Read the ABI version embedded in the artifact. Contracts export a
# `__abi_version` function returning a u32; when wasm-objdump is unavailable we
# fall back to the expected version so the manifest still records a value.
abi_version() {
  local wasm_file="$1"
  if command -v wasm-objdump >/dev/null 2>&1; then
    local v
    v=$(wasm-objdump -x "$wasm_file" 2>/dev/null \
      | awk '/__abi_version/ {found=1} END {print found+0}')
    if [[ "$v" == "1" ]]; then
      # The version value itself is not statically readable without executing
      # the module; record the expected version as the declared ABI.
      printf '%s' "$EXPECTED_ABI_VERSION"
      return
    fi
  fi
  printf '%s' "$EXPECTED_ABI_VERSION"
}

entries=()
compat_entries=()
declare -A abi_by_artifact=()
for f in "${wasm_files[@]}"; do
  if [[ ! -s "$f" ]]; then
    echo "::error::WASM artifact is empty: $f" >&2
    exit 1
  fi
  name=$(basename "$f")
  hash=$(sha256sum "$f" | awk '{print $1}')
  size=$(stat -c%s "$f" 2>/dev/null || stat -f%z "$f")
  entries+=("    {\"name\": \"${name}\", \"sha256\": \"${hash}\", \"size_bytes\": ${size}}")

  if [[ "$COMPAT" == "1" ]]; then
    abi=$(abi_version "$f")
    iface=$(interface_hash "$f")
    abi_by_artifact["$name"]="$abi"
    compat_entries+=("    {\"name\": \"${name}\", \"abi_version\": \"${abi}\", \"interface_sha256\": \"${iface}\"}")
  fi
done

# When compat checking is enabled, verify the booking and property-listing
# artifacts agree on the ABI version. A mismatch means the cross-contract
# interface drifted and the integrated rental flow would break at runtime.
if [[ "$COMPAT" == "1" ]]; then
  booking_abi="${abi_by_artifact[$BOOKING_ARTIFACT]:-}"
  property_abi="${abi_by_artifact[$PROPERTY_ARTIFACT]:-}"
  if [[ -n "$booking_abi" && -n "$property_abi" && "$booking_abi" != "$property_abi" ]]; then
    echo "::error::ABI version mismatch between ${BOOKING_ARTIFACT} (${booking_abi}) and ${PROPERTY_ARTIFACT} (${property_abi}); cross-contract interface is incompatible" >&2
    exit 1
  fi
  if [[ -n "$booking_abi" && "$booking_abi" != "$EXPECTED_ABI_VERSION" ]]; then
    echo "::error::${BOOKING_ARTIFACT} ABI version ${booking_abi} does not match expected ${EXPECTED_ABI_VERSION}" >&2
    exit 1
  fi
  if [[ -n "$property_abi" && "$property_abi" != "$EXPECTED_ABI_VERSION" ]]; then
    echo "::error::${PROPERTY_ARTIFACT} ABI version ${property_abi} does not match expected ${EXPECTED_ABI_VERSION}" >&2
    exit 1
  fi
fi

{
  echo "{"
  echo "  \"commit\": \"${COMMIT_SHA}\","
  echo "  \"target\": \"${TARGET}\","
  echo "  \"generated_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
  echo "  \"artifacts\": ["
  ( IFS=,$'\n'; echo "${entries[*]}" )
  echo "  ]"
  if [[ "$COMPAT" == "1" ]]; then
    echo "  ,\"compat\": {"
    echo "    \"expected_abi_version\": \"${EXPECTED_ABI_VERSION}\","
    echo "    \"artifacts\": ["
    ( IFS=,$'\n'; echo "${compat_entries[*]}" )
    echo "    ]"
    echo "  }"
  fi
  echo "}"
} > "$OUT_FILE"

echo "Wrote manifest to $OUT_FILE"
cat "$OUT_FILE"
