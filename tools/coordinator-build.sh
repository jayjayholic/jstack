#!/usr/bin/env bash
# Coordinator-only: runs install + codegen + build in one worktree, one build at a time, inside the heavy slot.
# The build itself runs under heavy_capped: a hard RAM ceiling (JSTACK_CAP_GB) and JSTACK_BUILD_ENV (worker cap).
# Usage: bash "$JSTACK_TOOLS/coordinator-build.sh" <worktree path>
# Prints PASS/FAIL and the log path; the log keeps the last build of that worktree.
set -uo pipefail
# shellcheck disable=SC1091
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/heavy-lock.sh"
wt="${1:?usage: coordinator-build.sh <worktree path>}"
log="$wt/artifacts/coordinator-build.log"
mkdir -p "$wt/artifacts"
ram_wait "$JSTACK_MIN_FREE_GB" || true
heavy_acquire "coordinator:$(basename "$wt")"
start=$(date +%s)
(
  cd "$wt" || exit 1
  eval "$JSTACK_INSTALL_CMD" >/dev/null 2>&1
  if [ -n "$JSTACK_CODEGEN_CMD" ]; then eval "$JSTACK_CODEGEN_CMD" || exit 1; fi
  heavy_capped "$JSTACK_BUILD_CMD"
) >"$log" 2>&1
code=$?
heavy_release
echo "$( [ $code -eq 0 ] && echo PASS || echo FAIL ) $(basename "$wt") in $(( $(date +%s) - start ))s, log: $log"
exit $code
