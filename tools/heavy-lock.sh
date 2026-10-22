#!/usr/bin/env bash
# One machine-wide slot for HEAVY jobs: builds, full typechecks and `git push` (if your pre-push hook typechecks).
# Usage: source "$JSTACK_TOOLS/heavy-lock.sh"; heavy_acquire <name>; <heavy command>; heavy_release
# Before starting a server: server_wait [min_free_gb] (waits for a free slot and enough RAM).
# Tests, installs and browser checks run without the slot. heavy_acquire also caps the Node heap (JSTACK_HEAP_MB);
# some bundlers (Turbopack) ignore that cap, which is why only one heavy job runs at a time.
# shellcheck disable=SC1091
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/jstack-env.sh"
mkdir -p "$(dirname "$JSTACK_LOCK_DIR")"
HEAVY_SLOTS=("$JSTACK_LOCK_DIR")

# A slot counts as abandoned only after JSTACK_STALE_MINUTES (a train build can run long). The owner file can vanish
# between the test and the stat while another holder releases the slot, so a failed stat means "not stale".
_stale() {
  local mtime
  mtime=$(stat -c %Y "$1/owner" 2>/dev/null || stat -f %m "$1/owner" 2>/dev/null) || return 1
  [ -n "$mtime" ] && [ $(( $(date +%s) - mtime )) -gt $(( JSTACK_STALE_MINUTES * 60 )) ]
}
heavy_acquire() {
  while :; do
    for slot in "${HEAVY_SLOTS[@]}"; do
      _stale "$slot" && rm -rf "$slot"
      if mkdir "$slot" 2>/dev/null; then
        echo "${1:-anon} $(date)" > "$slot/owner"
        export HEAVY_SLOT="$slot"
        export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=$JSTACK_HEAP_MB"
        return 0
      fi
    done
    sleep 10
  done
}
heavy_release() {
  if [ -n "${HEAVY_SLOT:-}" ]; then rm -rf "$HEAVY_SLOT"; unset HEAVY_SLOT; return 0; fi
  for slot in "${HEAVY_SLOTS[@]}"; do
    [ -n "${1:-}" ] && [ -f "$slot/owner" ] && [ "$(cut -d' ' -f1 "$slot/owner")" = "$1" ] && rm -rf "$slot"
  done
  return 0
}

# Waits until no heavy job holds the slot and enough RAM is free, before starting a server.
# Usage: source "$JSTACK_TOOLS/heavy-lock.sh"; server_wait [min_free_gb]
server_wait() {
  local need="${1:-$JSTACK_MIN_FREE_GB}" held free
  while :; do
    held=0; for s in "${HEAVY_SLOTS[@]}"; do [ -d "$s" ] && held=1; done
    free=$(jstack_free_gb)
    if [ "$held" = 0 ] && [ "${free:-0}" -ge "$need" ]; then return 0; fi
    sleep 30
  done
}
