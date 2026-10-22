#!/usr/bin/env bash
# Creates a ready-to-run worktree of the dashboard, like a fresh clone: the branch checked out plus the
# local-only files git does not carry (.env.keys, .env.local, .env.docker, .vercel). Only node_modules and
# generated code are missing; --install also runs `bun install` and `bun run db:generate`.
#
# Usage: bash scripts/new-worktree.sh <branch> [--base origin/stage] [--dir <path>] [--install]
#   <branch>   new branch name (created from --base) or an existing local/remote branch (checked out as is)
#   --base     base for a new branch (default origin/stage)
#   --dir      worktree path (default <repo>/.worktrees/<branch with / replaced by ->)
#   --install  also install dependencies and generate Prisma/ZenStack code
set -euo pipefail

REPO="$(cd "$(git rev-parse --git-common-dir)/.." && pwd)"
LOCAL_FILES=(.env.keys .env.local .env.docker)
LOCAL_DIRS=(.vercel)

branch="" base="origin/stage" dir="" install=0
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
[ -n "$dir" ] || dir="$REPO/.worktrees/${branch//\//-}"
[ -e "$dir" ] && { echo "already exists: $dir" >&2; exit 1; }

git -C "$REPO" fetch --quiet origin
if git -C "$REPO" show-ref --verify --quiet "refs/heads/$branch"; then
	git -C "$REPO" worktree add "$dir" "$branch"
elif git -C "$REPO" show-ref --verify --quiet "refs/remotes/origin/$branch"; then
	git -C "$REPO" worktree add --track -b "$branch" "$dir" "origin/$branch"
else
	git -C "$REPO" worktree add -b "$branch" "$dir" "$base"
fi

for file in "${LOCAL_FILES[@]}"; do
	[ -f "$REPO/$file" ] && cp "$REPO/$file" "$dir/$file" && echo "copied $file"
done
for folder in "${LOCAL_DIRS[@]}"; do
	[ -d "$REPO/$folder" ] && cp -r "$REPO/$folder" "$dir/$folder" && echo "copied $folder/"
done

if [ "$install" = 1 ]; then
	(cd "$dir" && bun install && bun run db:generate)
	next_steps="bun run dev"
else
	next_steps="bun install && bun run db:generate && bun run dev"
fi

echo
echo "Worktree ready: $dir (branch $branch)"
echo "Next: cd \"$dir\" && $next_steps"
echo "Remove when done: git -C $REPO worktree remove \"$dir\""
