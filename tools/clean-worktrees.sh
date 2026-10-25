#!/usr/bin/env bash
# Removes finished worktrees, safely. A worktree goes only when ALL hold: its branch is merged into
# origin/$JSTACK_INTEGRATION_BRANCH, it has no uncommitted work and no untracked files outside build/scratch output
# (artifacts/ .next/ node_modules/ .generated/ logs), no process runs inside it, and nothing in it changed in the last
# JSTACK_CLEAN_IDLE_MIN minutes (default 120). Anything else is skipped and listed. Branches are kept.
# Only one sweep runs at a time: it holds ${JSTACK_LOCK_DIR}-sweep, and a second sweep exits instead of racing it.
#
# Usage: bash clean-worktrees.sh [--dry-run] [--keep <pattern>]...
#   --dry-run  print what would be removed, remove nothing
#   --keep     a substring of worktree paths to never touch (repeatable), e.g. --keep train- --keep chain-
set -euo pipefail
# shellcheck disable=SC1091
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/jstack-env.sh"

dry=0 keep=()
while [ $# -gt 0 ]; do
	case "$1" in
		--dry-run) dry=1; shift ;;
		--keep) keep+=("$2"); shift 2 ;;
		*) echo "unknown argument: $1" >&2; exit 2 ;;
	esac
done

REPO="$(cd "$(git rev-parse --git-common-dir)/.." && pwd)"
idle_min="${JSTACK_CLEAN_IDLE_MIN:-120}"
sweep_lock="${JSTACK_LOCK_DIR}-sweep"
mkdir -p "$(dirname "$sweep_lock")"
if ! mkdir "$sweep_lock" 2>/dev/null; then
	echo "another sweep owns $sweep_lock ($(cat "$sweep_lock/owner" 2>/dev/null || echo unknown)); not running beside it" >&2
	exit 3
fi
echo "$$ $(date -u +%FT%TZ) @ $PWD" > "$sweep_lock/owner"
trap 'rm -rf "$sweep_lock"' EXIT
base="origin/${JSTACK_INTEGRATION_BRANCH}"
git -C "$REPO" fetch -q origin

busy_paths() {
	if command -v powershell >/dev/null 2>&1; then
		powershell -NoProfile -Command "Get-CimInstance Win32_Process | % { \$_.CommandLine }" 2>/dev/null | tr '\\' '/'
	else
		ps -eo args= 2>/dev/null
	fi
}
busy="$(busy_paths)"

removed=0 skipped=0
while read -r wt branch; do
	[ "$wt" = "$REPO" ] && continue
	for k in "${keep[@]:-}"; do [ -n "$k" ] && case "$wt" in *"$k"*) continue 2 ;; esac; done
	why=""
	if [ -z "$branch" ]; then why="detached HEAD"
	elif ! git -C "$REPO" merge-base --is-ancestor "$branch" "$base" 2>/dev/null; then why="not merged into $base"
	elif [ -n "$(git -C "$wt" status --porcelain 2>/dev/null | grep -vE '^\?\? "?(artifacts|\.next|node_modules|\.generated|logs)/|^\?\? "?[^/]*\.log"?$')" ]; then why="uncommitted or untracked work"
	elif printf '%s' "$busy" | grep -qF "$wt"; then why="a process runs inside it"
	elif [ -n "$(find "$wt" -path "$wt/node_modules" -prune -o -path "$wt/.next" -prune -o -path "$wt/.git" -prune -o -type f -mmin "-$idle_min" -print -quit 2>/dev/null)" ]; then why="changed in the last $idle_min min"
	fi
	if [ -n "$why" ]; then echo "skip   $wt ($why)"; skipped=$((skipped + 1)); continue; fi
	if [ "$dry" = 1 ]; then echo "would remove $wt"; removed=$((removed + 1)); continue; fi
	# worktree-deps.mjs unlinks every junction first: a bare git worktree remove (Git for Windows 2.40) follows the
	# shared node_modules/generated junctions and deletes the stores every other worktree links to.
	node "$JSTACK_TOOLS/worktree-deps.mjs" remove "$wt"
	echo "removed $wt"; removed=$((removed + 1))
done < <(git -C "$REPO" worktree list --porcelain | awk '/^worktree /{w=substr($0,10)} /^branch /{sub("refs/heads/","",$2); print w, $2; w=""} /^detached/{print w, ""; w=""}')

git -C "$REPO" worktree prune
echo "done: $removed removed, $skipped skipped"
