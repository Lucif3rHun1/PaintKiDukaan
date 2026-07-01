#!/usr/bin/env bash
# run-bench.sh — runs the list-perf harness skeleton (PR-2 placeholder)
# Future PRs will add Playwright + CDP for real FPS/response measurements.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node "${HERE}/bench/list-perf.mjs"
