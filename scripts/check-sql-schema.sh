#!/usr/bin/env bash
# Validates all .sql schema files compile against sqlite3 in-memory.
# Exits non-zero on syntax error so build/dev server stops early.

set -euo pipefail

SCHEMA_DIR="src-tauri/src/db"

if ! command -v sqlite3 &>/dev/null; then
  echo "ERROR: sqlite3 not found. Install it: brew install sqlite3 / apt install sqlite3"
  exit 1
fi

FAILED=0

# Only validate schema_final.sql — the canonical schema embedded at compile time.
# Migration files (schema_v2.sql, etc.) are incremental and can't run standalone.
SQL_FILE="$SCHEMA_DIR/schema_final.sql"

if [ ! -f "$SQL_FILE" ]; then
  echo "ERROR: $SQL_FILE not found"
  exit 1
fi

echo -n "Checking $(basename "$SQL_FILE")... "
if sqlite3 :memory: < "$SQL_FILE" 2>&1; then
  echo "OK"
else
  echo "FAIL"
  FAILED=1
fi

if [ "$FAILED" -ne 0 ]; then
  echo "SQL schema validation failed."
  exit 1
fi

echo "All SQL schemas valid."
