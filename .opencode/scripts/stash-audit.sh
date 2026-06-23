#!/usr/bin/env bash
# PaintKiDukaan session-start stash audit
#
# Run this at the start of every work session (or have the AI agent run it
# via its `bash` tool before touching files). Surfaces any in-flight work
# that has been stashed, so it doesn't get forgotten.
#
# Exit codes:
#   0 = clean (no stashes, or all stashes are recent and intentional)
#   1 = warning (stashes older than STASH_AGE_DAYS exist — review them)
#   2 = critical (stashes exist with no reachable recovery — fsck warning)

set -u

STASH_AGE_DAYS="${STASH_AGE_DAYS:-3}"
repo_root="$(git rev-parse --show-toplevel 2>/dev/null)"

if [ -z "$repo_root" ]; then
    echo "[stash-audit] not in a git repo — skipping"
    exit 0
fi

cd "$repo_root"

echo "=== Stash audit (${repo_root}) ==="
echo ""

# 1. List stashes
if ! git rev-parse --verify --quiet refs/stash >/dev/null 2>&1; then
    echo "✓ no stashes — clean"
    exit 0
fi

now_epoch="$(date +%s)"
cutoff_epoch=$(( now_epoch - STASH_AGE_DAYS * 86400 ))

echo "Live stashes (oldest first):"
git stash list --format='  %gd  %ct  (%s)' | head -20
echo ""

# 2. Identify stale stashes (using %ct = committer epoch, no parsing needed)
stale_count=0
while IFS='|' read -r ref stash_epoch subject; do
    [ -z "$ref" ] && continue
    if [ "$stash_epoch" -lt "$cutoff_epoch" ]; then
        age_days=$(( (now_epoch - stash_epoch) / 86400 ))
        echo "  ⚠  ${ref} is ${age_days} day(s) old: ${subject}"
        stale_count=$(( stale_count + 1 ))
    fi
done < <(git stash list --format='%gd|%ct|%s')

echo ""

if [ "$stale_count" -gt 0 ]; then
    echo "ACTION REQUIRED:"
    echo "  - Inspect:  git stash show -p <ref>  | head"
    echo "  - Apply:    git stash apply <ref>     (then commit if good)"
    echo "  - Drop:     git stash drop <ref>      (only if truly abandoned)"
    exit 1
fi

# 3. fsck for unreachable commits (the silent-killer scenario)
unreachable="$(git fsck --unreachable --no-reflogs 2>/dev/null | grep -E '^[0-9a-f]{40} commit' | head -5)"
if [ -n "$unreachable" ]; then
    echo "WARNING: unreachable commits detected in object store:"
    echo "$unreachable" | sed 's/^/  /'
    echo "These may be stashes that were dropped. Recover with:"
    echo "  git show <sha> --stat  (to see what was in it)"
    echo "  git checkout <sha> -- <path>  (to selectively restore files)"
    exit 2
fi

echo "✓ all stashes are recent and reachable"
exit 0
