#!/usr/bin/env bash
# generate-wasm-manifest.sh (#879)
#
# Produces a JSON deployment manifest describing the release WASM artifacts
# built from apps/contracts/: commit SHA, Rust toolchain, build target,
# per-artifact name + SHA-256 hash, plus (when provided) the target network,
# deployed contract IDs, and initialization transaction hashes. Intended to be
# run in CI right after `cargo build --release --target wasm32-unknown-unknown
# --all`, and uploaded as a CI artifact alongside the .wasm files themselves so
# a reviewer (or a later deploy step) can verify exactly which bytes were
# produced from which commit without re-building.
#
# The manifest is integrity-checked: a top-level `integrity` block records the
# SHA-256 of the canonical manifest body (everything except the integrity
# block itself), so tampering with any recorded field is detectable. Signing
# keys are intentionally NOT handled here — signing happens outside CI with an
# operator-held key, and production deploys require explicit operator approval.
#
# Wallet secret material (secret keys, seeds, mnemonics, signed XDR) is never
# read or written by this script. Only public identifiers (contract IDs,
# transaction hashes, network passphrase) are recorded.
#
# Usage:
#   apps/contracts/scripts/generate-wasm-manifest.sh <wasm-dir> <output-file> [commit-sha]
#
# Optional environment variables:
#   NETWORK              Target network name (e.g. testnet, mainnet). Default: unknown
#   NETWORK_PASSPHRASE   Stellar network passphrase. Default: unknown
#   CONTRACT_IDS         JSON object mapping artifact name -> deployed contract ID,
#                        e.g. '{"hello_world.wasm":"CABC..."}'. Default: {}
#   INIT_TX_HASHES       JSON object mapping artifact name -> initialization
#                        transaction hash, e.g. '{"hello_world.wasm":"ab12..."}'.
#                        Default: {}
#
# Example:
#   apps/contracts/scripts/generate-wasm-manifest.sh \
#     target/wasm32-unknown-unknown/release \
#     target/wasm32-unknown-unknown/release/manifest.json \
#     "$GITHUB_SHA"

set -euo pipefail

WASM_DIR="${1:?Usage: generate-wasm-manifest.sh <wasm-dir> <output-file> [commit-sha]}"
OUT_FILE="${2:?Usage: generate-wasm-manifest.sh <wasm-dir> <output-file> [commit-sha]}"
COMMIT_SHA="${3:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}"
TARGET="wasm32-unknown-unknown"
NETWORK="${NETWORK:-unknown}"
NETWORK_PASSPHRASE="${NETWORK_PASSPHRASE:-unknown}"
CONTRACT_IDS="${CONTRACT_IDS:-{\}}"
INIT_TX_HASHES="${INIT_TX_HASHES:-{\}}"

# Guard: refuse to run if any wallet secret material is present in the
# environment we would otherwise be tempted to serialize. We never read these
# values, but failing loudly makes accidental leakage impossible.
for forbidden in STELLAR_SECRET_KEY SOROBAN_SECRET_KEY SECRET_KEY WALLET_SECRET SEED_PHRASE MNEMONIC; do
  if [[ -n "${!forbidden:-}" ]]; then
    echo "::error::Refusing to generate manifest: secret material detected in \$${forbidden}. Unset it before running." >&2
    exit 1
  fi
done

# Validate that the contract ID / init tx maps are JSON objects so the emitted
# manifest stays well-formed.
for var_name in CONTRACT_IDS INIT_TX_HASHES; do
  value="${!var_name}"
  if [[ "${value:0:1}" != "{" || "${value: -1}" != "}" ]]; then
    echo "::error::\$${var_name} must be a JSON object, got: ${value}" >&2
    exit 1
  fi
done

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

entries=()
for f in "${wasm_files[@]}"; do
  if [[ ! -s "$f" ]]; then
    echo "::error::WASM artifact is empty: $f" >&2
    exit 1
  fi
  name=$(basename "$f")
  hash=$(sha256sum "$f" | awk '{print $1}')
  size=$(stat -c%s "$f" 2>/dev/null || stat -f%z "$f")
  entries+=("    {\"name\": \"${name}\", \"sha256\": \"${hash}\", \"size_bytes\": ${size}}")
done

RUSTC_VERSION="$(rustc --version 2>/dev/null || echo unknown)"
CARGO_VERSION="$(cargo --version 2>/dev/null || echo unknown)"
GENERATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Build the canonical manifest body (everything except the integrity block).
BODY_FILE="$(mktemp)"
trap 'rm -f "$BODY_FILE"' EXIT

{
  echo "{"
  echo "  \"commit\": \"${COMMIT_SHA}\","
  echo "  \"toolchain\": {"
  echo "    \"rustc\": \"${RUSTC_VERSION}\","
  echo "    \"cargo\": \"${CARGO_VERSION}\""
  echo "  },"
  echo "  \"target\": \"${TARGET}\","
  echo "  \"network\": {"
  echo "    \"name\": \"${NETWORK}\","
  echo "    \"passphrase\": \"${NETWORK_PASSPHRASE}\""
  echo "  },"
  echo "  \"generated_at\": \"${GENERATED_AT}\","
  echo "  \"artifacts\": ["
  ( IFS=,$'\n'; echo "${entries[*]}" )
  echo "  ],"
  echo "  \"contract_ids\": ${CONTRACT_IDS},"
  echo "  \"init_tx_hashes\": ${INIT_TX_HASHES}"
  echo "}"
} > "$BODY_FILE"

BODY_HASH="$(sha256sum "$BODY_FILE" | awk '{print $1}')"

# Emit the final manifest: canonical body + integrity block. The integrity
# block is excluded from the hash so it can be recomputed by verifiers.
{
  # Strip the trailing closing brace of the body, append the integrity block.
  sed '$d' "$BODY_FILE"
  echo "  ,"
  echo "  \"integrity\": {"
  echo "    \"algorithm\": \"sha256\","
  echo "    \"body_sha256\": \"${BODY_HASH}\""
  echo "  }"
  echo "}"
} > "$OUT_FILE"

echo "Wrote manifest to $OUT_FILE"
cat "$OUT_FILE"
