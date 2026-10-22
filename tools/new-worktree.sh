#!/usr/bin/env bash
# Creates a ready-to-run worktree, like a fresh clone: the branch checked out plus the local-only files git does not
# carry (JSTACK_LOCAL_ENV_FILES, JSTACK_LOCAL_DIRS). Only dependencies and generated code are missing; --install
# also runs JSTACK_INSTALL_CMD and JSTACK_CODEGEN_CMD.
#
# Usage: bash new-worktree.sh <branch> [--base origin/<integration branch>] [--dir <path>] [--install]
#   <branch>   new branch name (created from --base) or an existing local/remote branch (checked out as is)
#   --base     base for a new branch (default origin/$JSTACK_INTEGRATION_BRANCH)
#   --dir      worktree path (default $JSTACK_WORKTREES_DIR/<branch with / replaced by ->)
#   --install  also install dependencies and run codegen
set -euo pipefail
# shellcheck disable=SC1091
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/jstack-env.sh"

# The main checkout, even when this runs from inside another worktree.
REPO="$(git -C "$JSTACK_REPO_ROOT" worktree list --porcelain | head -1 | cut -d' ' -f2-)"

branch="" base="origin/$JSTACK_INTEGRATION_BRANCH" dir="" install=0
while [ $# -gt 0 ]; do
	case "$1" in
		--base) base="$2"; shift 2 ;;
		--dir) dir="$2"; shift 2 ;;
		--install) install=1; shift ;;
		-h|--help) sed -n '2,11p' "$0"; exit 0 ;;
		-*) echo "unknown option: $1" >&2; exit 2 ;;
		*) branch="$1"; shift ;;
	esac
done
[ -n "$branch" ] || { sed -n '2,11p' "$0"; exit 2; }
[ -n "$dir" ] || dir="$JSTACK_WORKTREES_DIR/${branch//\//-}"
[ -e "$dir" ] && { echo "already exists: $dir" >&2; exit 1; }

git -C "$REPO" fetch --quiet origin
if git -C "$REPO" show-ref --verify --quiet "refs/heads/$branch"; then
	git -C "$REPO" worktree add "$dir" "$branch"
elif git -C "$REPO" show-ref --verify --quiet "refs/remotes/origin/$branch"; then
	git -C "$REPO" worktree add --track -b "$branch" "$dir" "origin/$branch"
else
	git -C "$REPO" worktree add -b "$branch" "$dir" "$base"
fi

for file in $JSTACK_LOCAL_ENV_FILES; do
	[ -f "$REPO/$file" ] && cp "$REPO/$file" "$dir/$file" && echo "copied $file"
done
for folder in $JSTACK_LOCAL_DIRS; do
	[ -d "$REPO/$folder" ] && cp -r "$REPO/$folder" "$dir/$folder" && echo "copied $folder/"
done

setup="$JSTACK_INSTALL_CMD${JSTACK_CODEGEN_CMD:+ && $JSTACK_CODEGEN_CMD}"
if [ "$install" = 1 ]; then
	(cd "$dir" && eval "$setup")
	echo; echo "Worktree ready: $dir (branch $branch)"
else
	echo; echo "Worktree ready: $dir (branch $branch)"
	echo "Next: cd \"$dir\" && $setup"
fi
echo "Remove when done: git -C \"$REPO\" worktree remove \"$dir\""
