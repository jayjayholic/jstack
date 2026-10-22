#!/usr/bin/env bash
# Coordinator-only: runs `next build --turbopack` in one worktree, one build at a time, with a 4 GB heap cap.
# Usage: bash /c/dev/hakutaku/tools/coordinator-build.sh <worktree path>
# Prints PASS/FAIL and the log path; the log keeps the last build of that worktree.
set -uo pipefail
wt="$1"
log="$wt/artifacts/coordinator-build.log"
mkdir -p "$wt/artifacts"
source /c/dev/hakutaku/heavy-lock.sh
HEAVY_SLOTS=(/c/dev/hakutaku/.heavy-lock)
heavy_acquire "coordinator:$(basename "$wt")"
start=$(date +%s)
(cd "$wt" && bun install >/dev/null 2>&1; bun run db:generate && rm -rf .next && NODE_OPTIONS="--max-old-space-size=4096" bunx next build --turbopack) >"$log" 2>&1
code=$?
heavy_release
echo "$( [ $code -eq 0 ] && echo PASS || echo FAIL ) $(basename "$wt") in $(( $(date +%s) - start ))s, log: $log"
exit $code
