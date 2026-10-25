#!/usr/bin/env bash
# One machine-wide slot for HEAVY jobs: builds and full typechecks (and `git push` only while a pre-push hook typechecks).
# Usage: source "$JSTACK_TOOLS/heavy-lock.sh"; heavy_acquire <name>; heavy_capped "<heavy command>"; heavy_release
# Worker agents typecheck in their own lane instead: tc_run "<typecheck command>" (JSTACK_TC_SLOTS parallel slots).
# Before starting a server: server_wait [min_free_gb] (waits for a free slot and enough RAM).
# Servers, screenshot runs, live proofs, tests and installs run WITHOUT the slot. heavy_acquire also caps the Node heap
# (JSTACK_HEAP_MB); some bundlers (Turbopack) ignore that cap, which is why heavy_capped puts a hard RAM ceiling on
# the whole process tree as well.
# Memory guards: heavy_acquire waits for JSTACK_HEAVY_MIN_AVAIL_GB free once it holds the slot; tc_run waits while a
# build holds the slot and for JSTACK_TC_MIN_AVAIL_GB free. Each wait gives up after JSTACK_MEM_WAIT_MAX_MIN and runs
# anyway (the hard cap still applies). MEM_GUARD=0 turns them off. mem_guard [gb] waits on its own; mem_map prints the
# memory map (Windows, tools/mem-map.ps1).
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
# Owner line: "<name> <date> @ <cwd>". The first word stays the name (heavy_release matches it); mem-map reads the cwd.
_owner_line() { echo "${1:-anon} $(date) @ $(pwd -W 2>/dev/null || pwd)"; }

# Waits until <gb> GB are free. Returns 0 when they are (or RAM can't be read), 1 after <max_min> minutes.
# Usage: mem_guard [gb=JSTACK_TC_MIN_AVAIL_GB] [max_min=JSTACK_MEM_WAIT_MAX_MIN]
mem_guard() {
  local need="${1:-$JSTACK_TC_MIN_AVAIL_GB}" max="${2:-$JSTACK_MEM_WAIT_MAX_MIN}" start free said=0
  [ "${MEM_GUARD:-1}" = 0 ] && return 0
  start=$(date +%s)
  while :; do
    free=$(jstack_free_gb)
    { [ -z "$free" ] || [ "$free" = 0 ]; } && return 0
    [ "$free" -ge "$need" ] && return 0
    if [ $(( $(date +%s) - start )) -ge $(( max * 60 )) ]; then
      echo "mem_guard: ${free} GB free < ${need} GB after ${max} min, going ahead (run mem_map to see who holds it)" >&2
      return 1
    fi
    if [ $(( $(date +%s) - said )) -ge 300 ]; then echo "mem_guard: ${free} GB free, waiting for ${need} GB" >&2; said=$(date +%s); fi
    sleep 20
  done
}

# The memory map (Windows only): totals, private bytes per process group and per agent, WSL/Docker, orphans, slots.
# mem_map -Watch -Every 30 samples to a CSV; mem_map -Summary shows each agent's peak; mem_map -Kill orphans.
mem_map() {
  local locks i
  locks=$(cygpath -w "$JSTACK_LOCK_DIR")
  for i in $(seq 1 "$JSTACK_TC_SLOTS"); do locks="$locks;$(cygpath -w "${JSTACK_LOCK_DIR}-tc-$i")"; done
  powershell -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$JSTACK_TOOLS/mem-map.ps1")" \
    -LockDirs "$locks" ${JSTACK_QUEUE_FILE:+-QueueFile "$(cygpath -w "$JSTACK_QUEUE_FILE")"} "$@"
}

heavy_acquire() {
  while :; do
    for slot in "${HEAVY_SLOTS[@]}"; do
      _stale "$slot" && rm -rf "$slot"
      if mkdir "$slot" 2>/dev/null; then
        _owner_line "${1:-anon}" > "$slot/owner"
        export HEAVY_SLOT="$slot"
        export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=$JSTACK_HEAP_MB"
        # Hold the slot while waiting so no typecheck starts meanwhile; refresh the owner so the wait never looks stale.
        mem_guard "$JSTACK_HEAVY_MIN_AVAIL_GB"
        _owner_line "${1:-anon}" > "$slot/owner"
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

# Typecheck lane for worker agents: JSTACK_TC_SLOTS slots of their own (default 2), separate from the heavy slot, so a
# pre-READY typecheck never queues behind the train and never piles up. Each run is capped at JSTACK_TC_CAP_GB.
# A native tsc peaks around 5 GB; 4 parallel lanes took a 32 GB laptop to 0.3 GB free, 2 is the tested number.
# Usage: source "$JSTACK_TOOLS/heavy-lock.sh"; tc_run "$JSTACK_TYPECHECK_CMD"
# True while someone else's build holds the slot. A slot held from this shell ($HEAVY_SLOT) or whose owner line names
# this directory is ours, so the train can typecheck inside its own slot without waiting on itself.
_heavy_held_by_other() {
  local s here line; here=$(pwd -W 2>/dev/null || pwd)
  for s in "${HEAVY_SLOTS[@]}"; do
    [ -d "$s" ] || continue
    [ -n "${HEAVY_SLOT:-}" ] && [ "$HEAVY_SLOT" = "$s" ] && continue
    line=$(cat "$s/owner" 2>/dev/null)
    [[ "${line,,}" == *"@ ${here,,}"* ]] && continue
    return 0
  done
  return 1
}

tc_run() {
  local cmd="${1:-$JSTACK_TYPECHECK_CMD}" slot="" s i code start m
  while [ -z "$slot" ]; do
    for i in $(seq 1 "$JSTACK_TC_SLOTS"); do
      s="${JSTACK_LOCK_DIR}-tc-$i"
      _stale "$s" && rm -rf "$s"
      if mkdir "$s" 2>/dev/null; then _owner_line tc > "$s/owner"; slot="$s"; break; fi
    done
    [ -z "$slot" ] && sleep 10
  done
  # Wait out a build, start 90 s after the other lane at the earliest (a typecheck allocates over its first minute),
  # then wait for free RAM. Each wait gives up after JSTACK_MEM_WAIT_MAX_MIN.
  if [ "${MEM_GUARD:-1}" != 0 ]; then
    start=$(date +%s)
    while _heavy_held_by_other && [ $(( $(date +%s) - start )) -lt $(( JSTACK_MEM_WAIT_MAX_MIN * 60 )) ]; do sleep 20; done
    for i in $(seq 1 "$JSTACK_TC_SLOTS"); do
      s="${JSTACK_LOCK_DIR}-tc-$i"; [ "$s" = "$slot" ] && continue
      m=$(stat -c %Y "$s/owner" 2>/dev/null || stat -f %m "$s/owner" 2>/dev/null) && [ $(( $(date +%s) - m )) -lt 90 ] && sleep $(( 90 - ($(date +%s) - m) ))
    done
    mem_guard "$JSTACK_TC_MIN_AVAIL_GB"
    _owner_line tc > "$slot/owner"
  fi
  JSTACK_CAP_GB="$JSTACK_TC_CAP_GB" heavy_capped "$cmd"; code=$?
  rm -rf "$slot"
  return $code
}
