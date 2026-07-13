#!/usr/bin/env bash
# Leak-check gate: surface suspect logging before release.
# Errors block on Rust log macros that may emit secrets.
# Warnings are advisory for frontend console.log / log_frontend misuse.
set -uo pipefail

rc=0

# ── Rust backend: log macros must not emit raw secrets ──────────────────────
# Matches log::info!/debug!/trace! lines containing value= / password= / etc.
# Known-safe compound fields (value_hash=, key_id=, etc.) are excluded as a
# conservative allow-list; human review is still expected for any hit.
rust_leaks=$(grep -RnE 'log::(info|debug|trace)!.*\b(value|password|passphrase|secret|token|key)=' src-tauri/src \
  | grep -Ev '(value_hash|password_hash|passphrase_hash|secret_id|token_id|key_id)=' || true)
if [ -n "$rust_leaks" ]; then
  echo "ERROR: possible secret leak in Rust log macro (review and sanitize):"
  echo "$rust_leaks"
  rc=1
fi

# ── Frontend: console.log is allowed for intentional boot logging only ─────────
# Filter out rawConsole handles, .bind() references, and comment lines.
console_logs=$(grep -Rn --include='*.ts' --include='*.tsx' 'console\.log' src \
  | grep -Ev ':[0-9]+:\s*//|rawConsole|console\.log\.bind' || true)
if [ -n "$console_logs" ]; then
  echo "WARN: console.log found in src/ — confirm intentional (boot logs OK, remove debug leftovers):"
  echo "$console_logs"
fi

# ── Frontend: log_frontend must be error/warn only, or dev-gated ────────────
# The session logger (src/lib/security/sessionLog.ts) is the only approved
# caller that forwards info/debug/trace; every other call should be error/warn.
log_frontend_hits=$(grep -RnA 2 --include='*.ts' --include='*.tsx' 'tauriInvoke("log_frontend"\|internals\.invoke("log_frontend")' src || true)
if [ -n "$log_frontend_hits" ]; then
  suspect=$(echo "$log_frontend_hits" | awk '
    /^--$/ { next }
    /^[^ ]+:[0-9]+:/ {
      if (block != "" && !ok) print block;
      block = $0;
      ok = 0;
      next;
    }
    { block = block ORS $0; if ($0 ~ /level:[[:space:]]*"(error|warn)"/) ok = 1 }
    END { if (block != "" && !ok) print block }
  ')
  if [ -n "$suspect" ]; then
    echo "WARN: log_frontend call not restricted to error/warn — must be dev-gated or part of the session logger:"
    echo "$suspect"
  fi
fi

exit "$rc"
