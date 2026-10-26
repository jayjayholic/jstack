#!/usr/bin/env bash
# Shared settings for every jstack script. Each value is an env var with a default, so you can either
# export it, or put the exports in your config file (default ~/.jstack/config.sh, see config.example.sh).
# Sourced by the other scripts; you never run this one directly.

JSTACK_CONFIG="${JSTACK_CONFIG:-$HOME/.jstack/config.sh}"
# shellcheck disable=SC1090
[ -f "$JSTACK_CONFIG" ] && . "$JSTACK_CONFIG"

JSTACK_TOOLS="${JSTACK_TOOLS:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
JSTACK_LOCK_DIR="${JSTACK_LOCK_DIR:-$HOME/.jstack/heavy-lock}"
JSTACK_REPO_ROOT="${JSTACK_REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
JSTACK_WORKTREES_DIR="${JSTACK_WORKTREES_DIR:-$JSTACK_REPO_ROOT/.worktrees}"
JSTACK_TRAIN_DIR="${JSTACK_TRAIN_DIR:-$JSTACK_WORKTREES_DIR/train}"
JSTACK_INTEGRATION_BRANCH="${JSTACK_INTEGRATION_BRANCH:-main}"
JSTACK_INSTALL_CMD="${JSTACK_INSTALL_CMD:-npm install}"
JSTACK_SHARED_DEPS="${JSTACK_SHARED_DEPS:-1}"
case "$JSTACK_INSTALL_CMD" in
	"bun install"*) _store_install="bun install --frozen-lockfile" ;;
	"pnpm install"*) _store_install="pnpm install --frozen-lockfile" ;;
	"npm install"*) _store_install="npm ci" ;;
	*) _store_install="$JSTACK_INSTALL_CMD" ;;
esac
JSTACK_STORE_INSTALL_CMD="${JSTACK_STORE_INSTALL_CMD:-$_store_install}"
JSTACK_CODEGEN_CMD="${JSTACK_CODEGEN_CMD:-}"
JSTACK_TYPECHECK_CMD="${JSTACK_TYPECHECK_CMD:-npx tsc --noEmit}"
JSTACK_BUILD_CMD="${JSTACK_BUILD_CMD:-npm run build}"
JSTACK_FORMAT_CMD="${JSTACK_FORMAT_CMD:-}"
JSTACK_LOCAL_ENV_FILES="${JSTACK_LOCAL_ENV_FILES:-.env .env.local}"
JSTACK_LOCAL_DIRS="${JSTACK_LOCAL_DIRS:-}"
JSTACK_UNION_FILES="${JSTACK_UNION_FILES:-}"
JSTACK_PR_TEMPLATE="${JSTACK_PR_TEMPLATE:-.github/pull_request_template.md}"
JSTACK_MIN_FREE_GB="${JSTACK_MIN_FREE_GB:-8}"
JSTACK_HEAP_MB="${JSTACK_HEAP_MB:-4096}"
JSTACK_STALE_MINUTES="${JSTACK_STALE_MINUTES:-45}"
JSTACK_CAP_GB="${JSTACK_CAP_GB:-12}"
JSTACK_BUILD_ENV="${JSTACK_BUILD_ENV:-}"
JSTACK_TRAIN_BUILD="${JSTACK_TRAIN_BUILD:-local}"
JSTACK_CODEGEN_INPUTS="${JSTACK_CODEGEN_INPUTS:-}"
JSTACK_CODEGEN_REUSE_PATHS="${JSTACK_CODEGEN_REUSE_PATHS:-}"
JSTACK_CODEGEN_REQUIRED="${JSTACK_CODEGEN_REQUIRED:-}"
JSTACK_TC_SLOTS="${JSTACK_TC_SLOTS:-2}"
JSTACK_TC_CAP_GB="${JSTACK_TC_CAP_GB:-8}"
JSTACK_HEAVY_MIN_AVAIL_GB="${JSTACK_HEAVY_MIN_AVAIL_GB:-12}"
JSTACK_TC_MIN_AVAIL_GB="${JSTACK_TC_MIN_AVAIL_GB:-10}"
JSTACK_MEM_WAIT_MAX_MIN="${JSTACK_MEM_WAIT_MAX_MIN:-15}"
# Admission (heavy_acquire, tc_run): measured peaks per job, margin on top, ceiling for one job's need, poll and status.
JSTACK_JOB_PEAKS="${JSTACK_JOB_PEAKS:-$HOME/.jstack/job-peaks.tsv}"
JSTACK_ADMIT_MARGIN_PCT="${JSTACK_ADMIT_MARGIN_PCT:-15}"
JSTACK_ADMIT_MAX_GB="${JSTACK_ADMIT_MAX_GB:-16}"
JSTACK_ADMIT_POLL_S="${JSTACK_ADMIT_POLL_S:-20}"
JSTACK_ADMIT_SAY_S="${JSTACK_ADMIT_SAY_S:-300}"
JSTACK_ADMIT_FORCE="${JSTACK_ADMIT_FORCE:-0}"
# Running jobs report status every JSTACK_STATUS_EVERY_S; older than JSTACK_STATUS_FRESH_S means not running. No CPU
# progress for JSTACK_HUNG_MIN while holding a slot = hung (flagged, reservation dropped).
JSTACK_STATUS_EVERY_S="${JSTACK_STATUS_EVERY_S:-15}"
JSTACK_STATUS_FRESH_S="${JSTACK_STATUS_FRESH_S:-60}"
JSTACK_HUNG_MIN="${JSTACK_HUNG_MIN:-15}"
JSTACK_QUEUE_FILE="${JSTACK_QUEUE_FILE:-}"
# RAM clean (Windows): the scheduled task tools/setup-ram-clean.ps1 creates. Empty JSTACK_RAM_CLEAN_TASK turns it off.
JSTACK_RAM_CLEAN_TASK="${JSTACK_RAM_CLEAN_TASK-JstackRamClean}"
JSTACK_RAM_CLEAN_SETTLE_S="${JSTACK_RAM_CLEAN_SETTLE_S:-60}"
JSTACK_RAM_CLEAN_SKIP_ABOVE_PCT="${JSTACK_RAM_CLEAN_SKIP_ABOVE_PCT:-40}"
JSTACK_RAM_CLEAN_COOLDOWN_S="${JSTACK_RAM_CLEAN_COOLDOWN_S:-300}"
JSTACK_LOCK_SCRIPT="${JSTACK_LOCK_SCRIPT:-$JSTACK_TOOLS/heavy-lock.sh}"
JSTACK_UNIT_TEST_CMD="${JSTACK_UNIT_TEST_CMD:-}"
JSTACK_PRETTIER_CHECK_CMD="${JSTACK_PRETTIER_CHECK_CMD:-npx prettier --check --ignore-unknown}"
JSTACK_READY_EXTRA_CMD="${JSTACK_READY_EXTRA_CMD:-}"
# Discipline checks in ready-gate.sh (7-9): off | warn | block. Pre-flight and unslop start at warn; memory blocks
# only in repos that opted in with .jstack/memory (memory.mjs init).
JSTACK_READY_PREFLIGHT="${JSTACK_READY_PREFLIGHT:-warn}"
JSTACK_READY_UNSLOP="${JSTACK_READY_UNSLOP:-warn}"
JSTACK_READY_MEMORY="${JSTACK_READY_MEMORY:-block}"
# /unslop: agents in flight, candidates confirmed per run, seconds the fast gate may take.
JSTACK_UNSLOP_MAX_AGENTS="${JSTACK_UNSLOP_MAX_AGENTS:-4}"
JSTACK_UNSLOP_MAX_CANDIDATES="${JSTACK_UNSLOP_MAX_CANDIDATES:-25}"
JSTACK_UNSLOP_GATE_SECONDS="${JSTACK_UNSLOP_GATE_SECONDS:-60}"

# Free physical RAM in whole GB. Linux reads /proc/meminfo (MemAvailable, or MemFree where that's missing, like
# Git Bash on Windows), macOS vm_stat, Windows PowerShell. Set JSTACK_FREE_GB_CMD to any command that prints a
# number to override it. Prints 0 when nothing works, so the waits block instead of letting a build through blind.
# On Windows this is "Available" (free + standby; Git Bash's MemFree matched it within 0.3 GB when measured), on purpose:
# the true free list sits near 0 under load and RAMMap -Ew never raises it, so a free-list guard would never pass.
jstack_free_gb() {
  local gb=""
  if [ -n "${JSTACK_FREE_GB_CMD:-}" ]; then
    gb=$(eval "$JSTACK_FREE_GB_CMD")
  elif [ -r /proc/meminfo ]; then
    gb=$(awk '/^MemAvailable:/ {a=$2} /^MemFree:/ {f=$2} END {v=(a?a:f); if (v) print int(v/1048576)}' /proc/meminfo)
  elif command -v vm_stat >/dev/null 2>&1; then
    gb=$(vm_stat | awk '/page size of/ {ps=$8} /Pages (free|inactive)/ {gsub(/\./,"",$NF); p+=$NF} END {if (ps) print int(p*ps/1073741824)}')
  fi
  # node before PowerShell: same number, 48 vs 735 ms and 17 vs 63 MB (tools/perf ledger, 5 interleaved runs).
  if [ -z "$gb" ] && command -v node >/dev/null 2>&1; then
    gb=$(node -e "console.log(Math.floor(require('os').freemem()/2**30))" 2>/dev/null | tr -d '\r')
  fi
  if [ -z "$gb" ] && command -v powershell >/dev/null 2>&1; then
    gb=$(powershell -NoProfile -Command "[math]::Floor((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB)" 2>/dev/null | tr -d '\r')
  fi
  echo "${gb:-0}"
}

# Waits until at least <gb> (default JSTACK_MIN_FREE_GB) of RAM is free. Gives up after <max_minutes> (default 60).
ram_wait() {
  local need="${1:-$JSTACK_MIN_FREE_GB}" max="${2:-60}" i=0 free
  while :; do
    free=$(jstack_free_gb); free="${free:-0}"
    [ "$free" -ge "$need" ] && return 0
    i=$((i + 1)); [ $((i * 30)) -ge $((max * 60)) ] && { echo "ram_wait: still only ${free} GB free after ${max} min" >&2; return 1; }
    sleep 30
  done
}
