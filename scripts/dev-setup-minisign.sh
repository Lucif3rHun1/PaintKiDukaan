#!/usr/bin/env bash
# TEST-ONLY minisign keypair generator for local updater verification.
set -euo pipefail

if ! command -v minisign >/dev/null 2>&1; then
  echo "minisign not found. Install it:"
  echo "  macOS:   brew install minisign"
  echo "  Debian:  sudo apt install minisign"
  echo "  Other:   https://github.com/jedisct1/minisign"
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KP_DIR="$ROOT/src-tauri/tests/keypair"
mkdir -p "$KP_DIR"

PASS="paintkiduakan-dev"
printf '%s\n%s\n' "$PASS" "$PASS" | minisign -G -f \
  -p "$KP_DIR/minisign.pub" \
  -s "$KP_DIR/minisign.key"

PUBKEY_B64="$(base64 < "$KP_DIR/minisign.pub" | tr -d '\n')"

if ! grep -qx "src-tauri/tests/keypair/" "$ROOT/.gitignore" 2>/dev/null; then
  echo "src-tauri/tests/keypair/" >> "$ROOT/.gitignore"
fi

echo "TAURI_UPDATER_PUBKEY=$PUBKEY_B64"
echo "export TAURI_UPDATER_PUBKEY=\"$PUBKEY_B64\""
