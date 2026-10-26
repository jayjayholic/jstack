#!/usr/bin/env bash
# One machine-wide slot for HEAVY jobs: builds and full typechecks (and `git push` only while a pre-push hook typechecks).
# Usage: source "$JSTACK_TOOLS/heavy-lock.sh"; heavy_acquire <name>; heavy_capped "<heavy command>"; heavy_release
# Worker agents typecheck in their own lane instead: tc_run "<typecheck command>" (JSTACK_TC_SLOTS parallel slots).
# Before starting a server: server_wait [min_free_gb] (waits for a free slot and enough RAM).
# Servers, screenshot runs, live proofs, tests and installs run WITHOUT the slot. heavy_acquire also caps the Node heap
# (JSTACK_HEAP_MB); some bundlers (Turbopack) ignore that cap, which is why heavy_capped puts a hard RAM ceiling on
# the whole process tree as well.
# Admission by measured RAM: once heavy_acquire or tc_run holds its slot, the job starts only when available RAM minus
# what the other jobs reserved covers this job's need (see _admit). The need is the job's measured peak (its last 5
# heavy_capped runs in JSTACK_JOB_PEAKS, plus JSTACK_ADMIT_MARGIN_PCT), else JSTACK_HEAVY_MIN_AVAIL_GB /
# JSTACK_TC_MIN_AVAIL_GB, at most JSTACK_ADMIT_MAX_GB. The wait never gives up on its own: it prints a status line
# every JSTACK_ADMIT_SAY_S; --force (or JSTACK_ADMIT_FORCE=1) starts now. Before waiting it fires the RAM clean once.
# MEM_GUARD=0 turns admission off. mem_guard [gb] still waits on its own (and gives up after JSTACK_MEM_WAIT_MAX_MIN);
# mem_map prints the memory map (Windows, tools/mem-map.ps1).
# shellcheck disable=SC1091
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/jstack-env.sh"
mkdir -p "$(dirname "$JSTACK_LOCK_DIR")"
HEAVY_SLOTS=("$JSTACK_LOCK_DIR")

# A slot counts as abandoned only after JSTACK_STALE_MINUTES (a train build can run long). The owner file can vanish
# between the test and the stat while another holder releases the slot, so a failed stat means "not stale".
# A job still reporting status (see _slot_reserve) is never stale, however long it runs.
_stale() {
  local mtime
  _status_fresh "$1" && return 1
  mtime=$(stat -c %Y "$1/owner" 2>/dev/null || stat -f %m "$1/owner" 2>/dev/null) || return 1
  [ -n "$mtime" ] && [ $(( $(date +%s) - mtime )) -gt $(( JSTACK_STALE_MINUTES * 60 )) ]
}
# Owner line: "<name> <date> @ <cwd>". The first word stays the name (heavy_release matches it); mem-map reads the cwd.
_owner_line() { echo "${1:-anon} $(date) @ $(pwd -W 2>/dev/null || pwd)"; }

# RAM clean (Windows): tools/ram-clean.ps1 fires the scheduled task JSTACK_RAM_CLEAN_TASK (RAMMap -Ew under highest
# privileges, created once by tools/setup-ram-clean.ps1), so no UAC prompt. At most one run per
# JSTACK_RAM_CLEAN_COOLDOWN_S across every trigger on the machine; before/after numbers go to ~/.jstack/ram-clean.log.
# Silent no-op when the task, schtasks or PowerShell is missing (macOS, Linux, a machine without the setup).
# Triggers: mem_guard once per call when RAM is short (waits, then rechecks), and in the background after
# heavy_release, tc_run, installs and worktree removal: on a 32 GB laptop with ~10 agents, 16 of 21 climbs to 14+ GB
# of file cache had an install running, the rest a build, a typecheck or a worktree deletion.
_ram_clean() {
  [ -n "$JSTACK_RAM_CLEAN_TASK" ] && command -v schtasks.exe >/dev/null 2>&1 || return 1
  JSTACK_RAM_CLEAN_TASK="$JSTACK_RAM_CLEAN_TASK" JSTACK_RAM_CLEAN_COOLDOWN_S="$JSTACK_RAM_CLEAN_COOLDOWN_S" \
    powershell -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$JSTACK_TOOLS/ram-clean.ps1")" -Reason "$1" \
    -SkipAbovePct "${2:-0}" -SettleSec "$JSTACK_RAM_CLEAN_SETTLE_S" 2>/dev/null | tr -d '\r' | sed 's/^/ram_clean: /' >&2
  return "${PIPESTATUS[0]}"
}
# Background clean after a cache-filling job ends; never blocks the caller, skipped while RAM is plentiful.
ram_clean_after() { ( _ram_clean "$1" "$JSTACK_RAM_CLEAN_SKIP_ABOVE_PCT" & ) >/dev/null 2>&1; }

# Waits until <gb> GB are free. Returns 0 when they are (or RAM can't be read), 1 after <max_min> minutes.
# Usage: mem_guard [gb=JSTACK_TC_MIN_AVAIL_GB] [max_min=JSTACK_MEM_WAIT_MAX_MIN]
mem_guard() {
  local need="${1:-$JSTACK_TC_MIN_AVAIL_GB}" max="${2:-$JSTACK_MEM_WAIT_MAX_MIN}" start free said=0 cleaned=0
  [ "${MEM_GUARD:-1}" = 0 ] && return 0
  start=$(date +%s)
  while :; do
    free=$(jstack_free_gb)
    { [ -z "$free" ] || [ "$free" = 0 ]; } && return 0
    [ "$free" -ge "$need" ] && return 0
    # One clean per call, never a loop: if it can't make room, the wait below decides.
    if [ "$cleaned" = 0 ]; then cleaned=1; _ram_clean "mem_guard need ${need} GB" && continue; fi
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

# ---------- admission ----------
_tc_slots() { local i; for i in $(seq 1 "$JSTACK_TC_SLOTS"); do echo "${JSTACK_LOCK_DIR}-tc-$i"; done; }
_is_heavy_slot() { local s; for s in "${HEAVY_SLOTS[@]}"; do [ "$s" = "$1" ] && return 0; done; return 1; }
# A slot is ours when this shell holds it ($HEAVY_SLOT) or its owner line names this directory: the train typechecks
# inside its own slot without waiting on itself.
_slot_ours() {
  local line here; here=$(pwd -W 2>/dev/null || pwd)
  [ -n "${HEAVY_SLOT:-}" ] && [ "$HEAVY_SLOT" = "$1" ] && return 0
  line=$(cat "$1/owner" 2>/dev/null)
  [[ "${line,,}" == *"@ ${here,,}" ]]
}
# Job key in the peak ledger: the slot name up to its first colon ("coordinator:wt-a" -> "coordinator").
_job_key() { local k="${1:-anon}"; k="${k%%:*}"; printf '%s' "${k//[^A-Za-z0-9._-]/_}"; }
# GB a job needs: the max of its last 5 measured peaks + margin, rounded up; else <default>; at most JSTACK_ADMIT_MAX_GB
# (a job above that runs only when nothing else heavy does, since the others' reservations are subtracted).
job_need_gb() {
  local key="$1" default="$2" peak need
  peak=$(awk -F'\t' -v k="$key" '$2 == k { p[++n] = $3 } END { m = 0; for (i = (n > 5 ? n - 4 : 1); i <= n; i++) if (p[i] + 0 > m) m = p[i] + 0; if (n) print m }' "$JSTACK_JOB_PEAKS" 2>/dev/null)
  if [ -n "$peak" ]; then
    need=$(awk -v p="$peak" -v m="$JSTACK_ADMIT_MARGIN_PCT" 'BEGIN { v = p * (1 + m / 100); print (v == int(v)) ? v : int(v) + 1 }')
  else need="$default"; fi
  [ "$need" -gt "$JSTACK_ADMIT_MAX_GB" ] && need="$JSTACK_ADMIT_MAX_GB"
  echo "$need"
}
job_peak_record() {
  [ -n "$1" ] && [ -n "$2" ] || return 0
  mkdir -p "$(dirname "$JSTACK_JOB_PEAKS")" && printf '%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" >> "$JSTACK_JOB_PEAKS"
}
# Slot files: owner, need, admitted, holder (pid of the shell waiting or running in it) and status, which
# run-capped.ps1 rewrites every JSTACK_STATUS_EVERY_S while the job runs: "<pid> <used GB> <cpu s> <cpu idle since>
# <now>" (epoch seconds; used = the job's private bytes now).
_mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null; }
_status_fresh() { local m; m=$(_mtime "$1/status") && [ $(( $(date +%s) - m )) -le "$JSTACK_STATUS_FRESH_S" ]; }
# The holder shell is gone (no holder file = an older script: assume alive).
_holder_dead() { local h; h=$(cat "$1/holder" 2>/dev/null); [ -n "$h" ] && ! kill -0 "$h" 2>/dev/null; }
# Nothing runs in the slot any more: its shell died and no job reports status.
_slot_gone() { _holder_dead "$1" && ! _status_fresh "$1"; }
# One notice per hung slot, in the warden's notices (perf.mjs notices), never a kill: its agent or the owner decides.
_flag_hung() {
  local s="$1" min="$2" pid="$3" dir="${JSTACK_PERF_DIR:-$HOME/.jstack/perf}" wt
  [ -f "$s/hung-flagged" ] && return 0
  : > "$s/hung-flagged"
  wt=$(sed -n 's/.* @ //p' "$s/owner" 2>/dev/null)
  mkdir -p "$dir" && printf '{"at":"%s","type":"hung-slot","pid":%s,"name":"%s","wt":"%s","minutes":%s,"cmd":"no CPU progress while holding the slot; its reservation no longer counts"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${pid:-0}" "$(basename "$s")" "${wt//\\/\/}" "$min" >> "$dir/notices.jsonl"
  echo "heavy-lock: $(basename "$s") hung (no CPU progress for $min min), flagged in $dir/notices.jsonl" >&2
}
# GB of <need> a slot still holds back. A running job (fresh status) only what it has not used yet: its used memory
# is already missing from "available", so counting it again would be double. A hung job (no CPU progress for
# JSTACK_HUNG_MIN) nothing, and it is flagged. A slot whose process tree is gone nothing. Otherwise the whole need.
_slot_reserve() {
  local s="$1" n="$2" pid used cpu idle now
  if _status_fresh "$s"; then
    read -r pid used cpu idle now < "$s/status"
    now=$(date +%s); idle="${idle:-$now}"
    if [ $(( now - idle )) -ge $(( JSTACK_HUNG_MIN * 60 )) ]; then _flag_hung "$s" $(( (now - idle) / 60 )) "$pid"; echo 0; return; fi
    used=$(awk -v u="${used:-0}" 'BEGIN { printf "%d", (u > 0 ? u : 0) }')
    echo $(( n > used ? n - used : 0 )); return
  fi
  if _holder_dead "$s"; then echo 0; return; fi
  echo "$n"
}
# GB the other jobs hold back. Admitted jobs count what is left of their need (_slot_reserve). A heavy job still
# waiting counts against typechecks too, so tc lanes yield to a waiting build and never starve it; waiting typechecks
# count against nobody, so two waiters never block each other. A slot without a need file (an older lock script, or
# the instant after mkdir) counts its cap. A tc slot whose process tree is gone is removed (its wrapper never will).
_reserved_by_others() {
  local mine="$1" for_tc="$2" s n total=0
  for s in "${HEAVY_SLOTS[@]}" $(_tc_slots); do
    [ -d "$s" ] && [ "$s" != "$mine" ] || continue
    _is_heavy_slot "$s" && _slot_ours "$s" && continue
    if ! _is_heavy_slot "$s" && _slot_gone "$s"; then rm -rf "$s"; continue; fi
    n=$(cat "$s/need" 2>/dev/null)
    if [ -z "$n" ]; then
      if _is_heavy_slot "$s"; then n="$JSTACK_CAP_GB"; else n="$JSTACK_TC_CAP_GB"; fi
    elif [ ! -f "$s/admitted" ]; then
      { [ "$for_tc" = 1 ] && _is_heavy_slot "$s"; } || continue
    fi
    total=$(( total + $(_slot_reserve "$s" "$n") ))
  done
  echo "$total"
}
# Waits, holding <slot>, until available RAM minus the others' reservations covers <need> GB. Never gives up alone.
# Usage: _admit <slot> <need_gb> <for_tc 0|1> <label> <force 0|1>
_admit() {
  local slot="$1" need="$2" for_tc="$3" label="$4" force="$5" start free res said=0 cleaned=0
  echo "$need" > "$slot/need"
  echo "${BASHPID:-$$}" > "$slot/holder"
  start=$(date +%s)
  while [ "${MEM_GUARD:-1}" != 0 ] && [ "$force" != 1 ]; do
    free=$(jstack_free_gb)
    if [ -z "$free" ] || [ "$free" = 0 ]; then echo "heavy-lock: $label: RAM unreadable, starting without admission" >&2; break; fi
    res=$(_reserved_by_others "$slot" "$for_tc")
    [ $(( free - res )) -ge "$need" ] && break
    if [ "$cleaned" = 0 ]; then cleaned=1; _ram_clean "admit $label need ${need} GB" && continue; fi
    if [ $(( $(date +%s) - said )) -ge "$JSTACK_ADMIT_SAY_S" ]; then
      echo "heavy-lock: $label waits for ${need} GB: ${free} GB available, ${res} GB reserved by other jobs, $(( ($(date +%s) - start) / 60 )) min so far (--force or JSTACK_ADMIT_FORCE=1 starts it now)" >&2
      said=$(date +%s)
    fi
    touch "$slot/owner" 2>/dev/null
    sleep "$JSTACK_ADMIT_POLL_S"
  done
  : > "$slot/admitted"
}

# Usage: heavy_acquire <name> [--force] [--need GB]
heavy_acquire() {
  local name="" force="${JSTACK_ADMIT_FORCE:-0}" need="" slot
  while [ $# -gt 0 ]; do
    case "$1" in --force) force=1 ;; --need) need="$2"; shift ;; *) name="$1" ;; esac
    shift
  done
  name="${name:-anon}"
  while :; do
    for slot in "${HEAVY_SLOTS[@]}"; do
      _stale "$slot" && rm -rf "$slot"
      if mkdir "$slot" 2>/dev/null; then
        _owner_line "$name" > "$slot/owner"
        HEAVY_JOB=$(_job_key "$name")
        export HEAVY_SLOT="$slot" HEAVY_JOB
        export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=$JSTACK_HEAP_MB"
        _admit "$slot" "${need:-$(job_need_gb "$HEAVY_JOB" "$JSTACK_HEAVY_MIN_AVAIL_GB")}" 0 "heavy_acquire $name" "$force"
        _owner_line "$name" > "$slot/owner"
        return 0
      fi
    done
    sleep 10
  done
}
heavy_release() {
  ram_clean_after "after heavy_release${1:+ $1}"
  if [ -n "${HEAVY_SLOT:-}" ]; then rm -rf "$HEAVY_SLOT"; unset HEAVY_SLOT HEAVY_JOB; return 0; fi
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
# The measured peak goes to JSTACK_JOB_PEAKS under JSTACK_JOB_KEY (tc_run) or the slot's job (heavy_acquire).
# Inside a slot (JSTACK_SLOT from tc_run, else HEAVY_SLOT) it marks this shell as the holder and has run-capped.ps1
# write the job's status there for admission.
heavy_capped() {
  local cmd="$1" script peakf key="${JSTACK_JOB_KEY:-${HEAVY_JOB:-}}" slot="${JSTACK_SLOT:-${HEAVY_SLOT:-}}" status=()
  script=$(mktemp "${TMPDIR:-/tmp}/jstack-capped.XXXXXX")
  peakf="$script.peak"
  if [ -n "$slot" ] && [ -d "$slot" ]; then
    echo "${BASHPID:-$$}" > "$slot/holder"
    status=(-StatusFile "$(cygpath -w "$slot/status" 2>/dev/null || echo "$slot/status")" -StatusEverySec "$JSTACK_STATUS_EVERY_S")
  fi
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
        -WorkingDirectory "$(pwd -W)" -PeakFile "$(cygpath -w "$peakf")" "${status[@]}"
      code=$?
      [ -s "$peakf" ] && job_peak_record "$key" "$(tr -d '\r\n' < "$peakf")" ;;
    *)
      if command -v systemd-run >/dev/null 2>&1 && systemd-run --user --scope -q true >/dev/null 2>&1; then
        systemd-run --user --scope -q -p MemoryMax="${JSTACK_CAP_GB}G" -p MemorySwapMax=0 bash "$script"
      else
        echo "heavy_capped: no hard RAM cap on this OS, running uncapped" >&2
        bash "$script"
      fi
      code=$? ;;
  esac
  rm -f "$script" "$peakf"
  [ -n "$slot" ] && rm -f "$slot/status" "$slot/hung-flagged"
  return $code
}

# Typecheck lane for worker agents: JSTACK_TC_SLOTS slots of their own (default 2), separate from the heavy slot, so a
# pre-READY typecheck never queues behind the train and never piles up. Each run is capped at JSTACK_TC_CAP_GB.
# A native tsc peaks around 5 GB; 4 parallel lanes took a 32 GB laptop to 0.3 GB free, 2 is the tested number.
# Admission counts a build in the heavy slot (running or waiting) and the other lane, so a lane never stacks on them;
# the old "give up after 15 min" and the 90 s stagger are gone (the other lane's reservation covers its ramp-up).
# Usage: source "$JSTACK_TOOLS/heavy-lock.sh"; tc_run [--force] "$JSTACK_TYPECHECK_CMD"
# True while someone else's job holds the heavy slot (kept for callers; admission no longer uses it).
_heavy_held_by_other() {
  local s
  for s in "${HEAVY_SLOTS[@]}"; do [ -d "$s" ] && ! _slot_ours "$s" && return 0; done
  return 1
}

tc_run() {
  local force="${JSTACK_ADMIT_FORCE:-0}" slot="" s code key="${JSTACK_JOB_KEY:-typecheck}"
  [ "${1:-}" = --force ] && { force=1; shift; }
  local cmd="${1:-$JSTACK_TYPECHECK_CMD}"
  while [ -z "$slot" ]; do
    for s in $(_tc_slots); do
      { _stale "$s" || _slot_gone "$s"; } && rm -rf "$s"
      if mkdir "$s" 2>/dev/null; then _owner_line tc > "$s/owner"; echo "${BASHPID:-$$}" > "$s/holder"; slot="$s"; break; fi
    done
    [ -z "$slot" ] && sleep 10
  done
  _admit "$slot" "$(job_need_gb "$key" "$JSTACK_TC_MIN_AVAIL_GB")" 1 "tc_run" "$force"
  _owner_line tc > "$slot/owner"
  JSTACK_SLOT="$slot" JSTACK_JOB_KEY="$key" JSTACK_CAP_GB="$JSTACK_TC_CAP_GB" heavy_capped "$cmd"; code=$?
  rm -rf "$slot"
  ram_clean_after "after tc_run"
  return $code
}
