#!/usr/bin/env bash
# Generate Chrome/Firefox extension icon PNGs (16/32/48/128) from a single SVG source.
# Uses @resvg/resvg-js-cli via npx — no system dependencies beyond Node.

set -euo pipefail

SRC="packages/llmvault-extension/public/icons/logo.svg"
DST="packages/llmvault-extension/public/icons"

if [ ! -f "$SRC" ]; then
  echo "Source SVG not found at $SRC" >&2
  exit 1
fi

mkdir -p "$DST"

for size in 16 32 48 128; do
  npx --yes @resvg/resvg-js-cli --fit-width "$size" "$SRC" "$DST/icon-${size}.png"
done
