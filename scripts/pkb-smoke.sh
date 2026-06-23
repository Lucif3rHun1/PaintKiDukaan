#!/usr/bin/env bash
set -euo pipefail

# pkb-smoke.sh — fast inner-loop smoke test for PaintKiDukaan.
# Verifies: TypeScript type-check, Rust type-check, and prints the dev receipt PDF path.
# Does NOT launch the Tauri window (use `pnpm tauri:dev` for that).

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "[1/3] pnpm exec tsc -b"
pnpm exec tsc -b

echo "[2/3] cargo check (src-tauri)"
( cd src-tauri && cargo check )

echo "[3/3] dev receipt PDF path (macOS/Linux only)"
TMP_PDF="$( (uname | grep -qiE 'darwin|linux' && echo "${TMPDIR:-/tmp}/paintkiduakan/pkb-receipt-dev.pdf") || echo 'N/A (Windows — cmd_print_receipt_dev is disabled)' )"
echo "  → ${TMP_PDF}"

echo
echo "OK — smoke checks passed. Run 'pnpm tauri:dev' to launch."
