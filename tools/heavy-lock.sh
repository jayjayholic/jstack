#!/usr/bin/env bash
# One machine-wide slot for HEAVY jobs: builds and full typechecks (and `git push` only while a pre-push hook typechecks).
# Usage: source "$JSTACK_TOOLS/heavy-lock.sh"; heavy_acquire <name>; heavy_capped "<heavy command>"; heavy_release
# Before starting a server: server_wait [min_free_gb] (waits for a free slot and enough RAM).
# Servers, screenshot runs, live proofs, tests and installs run WITHOUT the slot. heavy_acquire also caps the Node heap
# (JSTACK_HEAP_MB); some bundlers (Turbopack) ignore that cap, which is why heavy_capped puts a hard RAM ceiling on
# the whole process tree as well.
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

# Runs one heavy command with a hard RAM ceiling for its whole process tree (JSTACK_CAP_GB) and the env in
# JSTACK_BUILD_ENV (use it to cap the build tool's workers). Past the ceiling the command dies with OOM instead of
# freezing the machine. Call it inside the slot: heavy_acquire <name>; heavy_capped "<cmd>"; heavy_release
#   Windows (Git Bash): a Job Object via run-capped.ps1. Tested.
#   Linux with systemd: systemd-run --user --scope -p MemoryMax. UNVERIFIED, test it on your machine first.
#   Anything else (macOS, Linux without systemd): runs uncapped with a warning. ulimit -v caps each process, not the
#   tree, and macOS mostly ignores it, so it is not used.
heavy_capped() {
  local cmd="$1" script
  script=$(mktemp "${TMPDIR:-/tmp}/jstack-capped.XXXXXX")
  {
    echo 'set -o pipefail'
    for kv in $JSTACK_BUILD_ENV; do printf 'export %q\n' "$kv"; done
    printf 'cd %q || exit 1\n' "$PWD"
    printf '%s\n' "$cmd"
  } > "$script"
  local code
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      powershell -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$JSTACK_TOOLS/run-capped.ps1")" \
        -LimitGB "$JSTACK_CAP_GB" -Exe "$(cygpath -w "$(command -v bash)")" -Command "\"$(cygpath -w "$script")\"" \
        -WorkingDirectory "$(pwd -W)"
      code=$? ;;
    *)
      if command -v systemd-run >/dev/null 2>&1 && systemd-run --user --scope -q true >/dev/null 2>&1; then
        systemd-run --user --scope -q -p MemoryMax="${JSTACK_CAP_GB}G" -p MemorySwapMax=0 bash "$script"
      else
        echo "heavy_capped: no hard RAM cap on this OS, running uncapped" >&2
        bash "$script"
      fi
      code=$? ;;
  esac
  rm -f "$script"
  return $code
}
