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
#   apps/contracts/scripts/generate-wasm-manifest.sh <wasm-dir> <output-file> [commit-sha]
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

{
  echo "{"
  echo "  \"commit\": \"${COMMIT_SHA}\","
  echo "  \"target\": \"${TARGET}\","
  echo "  \"generated_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
  echo "  \"artifacts\": ["
  ( IFS=,$'\n'; echo "${entries[*]}" )
  echo "  ]"
  echo "}"
} > "$OUT_FILE"

echo "Wrote manifest to $OUT_FILE"
cat "$OUT_FILE"
