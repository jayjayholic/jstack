#!/usr/bin/env bash
# The train. Settings come from jstack-env.sh (env vars or ~/.jstack/config.sh).
# Usage:
#   train.sh build <wt1> <wt2> ...        merge the branches onto a fresh integration branch in the train worktree,
#                                         then one typecheck + one build
#   train.sh assemble <wt1> <wt2> ...     merge only, no build
#   train.sh typebuild                    typecheck + build of the tree already assembled
#   train.sh shiptrain <branch> "<PR title>" <body-file>
#                                         push the train as <branch>, open ONE PR, merge only when every check passed
#   train.sh ship "<wt>|<title>" ...      ship single branches as their own PRs (no train, no rebuild)
set -uo pipefail
# shellcheck disable=SC1091
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/heavy-lock.sh"
R="$JSTACK_REPO_ROOT"
T="$JSTACK_TRAIN_DIR"
B="$JSTACK_INTEGRATION_BRANCH"
mode="${1:-}"; shift || true

# Merges $1 into HEAD. Conflicts only in JSTACK_UNION_FILES (append-only logs) keep both sides; any other conflict
# is printed and the merge is not attempted (the branch comes off the train).
union_merge() {
  local ref="$1" conflicts other f t
  conflicts=$(git merge-tree --write-tree --name-only HEAD "$ref" | tail -n +2 | grep -v '^$' | grep -v '^Auto-merging\|^CONFLICT')
  other=$(for f in $conflicts; do case " $JSTACK_UNION_FILES " in *" $f "*) ;; *) echo "$f";; esac; done)
  if [ -n "$other" ]; then echo "$other"; return 1; fi
  if ! git merge --no-edit "$ref" >/dev/null 2>&1 && [ -z "$conflicts" ]; then
    git merge --abort >/dev/null 2>&1; echo "merge failed (untracked files in the way?)"; return 1
  fi
  if [ -n "$conflicts" ]; then
    for f in $conflicts; do
      t=$(mktemp -d); git show ":1:$f" > "$t/b" 2>/dev/null || : > "$t/b"; git show ":2:$f" > "$t/o"; git show ":3:$f" > "$t/t"
      git merge-file --union "$t/o" "$t/b" "$t/t"; cp "$t/o" "$f"; git add "$f"
    done
    git commit -q --no-edit
  fi
  return 0
}

fresh_train_tree() {
  cd "$R" && git fetch -q origin "$B"
  if [ -d "$T" ]; then
    local keep=(-e node_modules); for e in $JSTACK_LOCAL_ENV_FILES $JSTACK_LOCAL_DIRS; do keep+=(-e "$e"); done
    git -C "$T" merge --abort >/dev/null 2>&1
    git -C "$T" checkout -q --detach "origin/$B" && git -C "$T" reset -q --hard "origin/$B" && git -C "$T" clean -qfd "${keep[@]}"
  else
    git worktree add -q --detach "$T" "origin/$B"
    for e in $JSTACK_LOCAL_ENV_FILES; do [ -f "$R/$e" ] && cp "$R/$e" "$T/"; done
    for d in $JSTACK_LOCAL_DIRS; do [ -d "$R/$d" ] && cp -r "$R/$d" "$T/"; done
  fi
  cd "$T"
}

board() {
  local wt b c
  for wt in "$@"; do
    b=$(git -C "$wt" branch --show-current)
    if c=$(union_merge "$b"); then echo "TRAIN+ $b"; else echo "TRAIN-CONFLICT $b: $(echo $c)"; fi
  done
}

# install + codegen outside the slot, typecheck inside it (a full typecheck is heavy too).
typecheck_tree() {
  mkdir -p artifacts
  eval "$JSTACK_INSTALL_CMD" >/dev/null 2>&1
  if [ -n "$JSTACK_CODEGEN_CMD" ]; then
    eval "$JSTACK_CODEGEN_CMD" > artifacts/train-typecheck.log 2>&1 || { echo "TRAIN-FAIL codegen"; tail -5 artifacts/train-typecheck.log; return 1; }
  fi
  heavy_acquire "train-typecheck"
  eval "$JSTACK_TYPECHECK_CMD" >> artifacts/train-typecheck.log 2>&1; local code=$?
  heavy_release
  [ $code -eq 0 ] || { echo "TRAIN-FAIL typecheck"; grep -iE "error" artifacts/train-typecheck.log | head -20; return 1; }
  echo "typecheck PASS"
}

build_tree() {
  ram_wait "$JSTACK_MIN_FREE_GB" || true
  echo "free=$(jstack_free_gb) GB"
  typecheck_tree || return 0
  local r; r=$(bash "$JSTACK_TOOLS/coordinator-build.sh" "$T" 2>&1 | tail -1); echo "$r"
  case "$r" in PASS*) echo "TRAIN-GREEN";; *) echo "TRAIN-FAIL build"; grep -nE "Error|error" "$T/artifacts/coordinator-build.log" | head -20;; esac
}

format_and_commit() {
  [ -n "$JSTACK_FORMAT_CMD" ] || return 0
  eval "$JSTACK_FORMAT_CMD" >/dev/null 2>&1
  git diff --quiet || { git commit -qam "style: format changed files" && echo "formatted"; }
}

# Waits for the PR's checks. Green (or no checks configured) returns 0; any failure returns 1.
checks_green() {
  local out code
  out=$(gh pr checks "$1" --watch 2>&1); code=$?
  [ $code -eq 0 ] && return 0
  echo "$out" | grep -qi "no checks reported" && return 0
  echo "$out" | grep -iE "fail" | head -5
  return 1
}

open_and_merge() { # $1 branch, $2 title, $3 body file
  local s
  gh pr view "$1" --json number >/dev/null 2>&1 || gh pr create --base "$B" --head "$1" --title "$2" --body-file "$3" 2>&1 | tail -1
  for _ in 1 2 3 4 5 6; do [ "$(gh pr view "$1" --json mergeable -q .mergeable)" = "MERGEABLE" ] && break; sleep 10; done
  if ! checks_green "$1"; then echo "NOT-MERGED $1: a check failed (re-run flakes and confirm green first)"; return 0; fi
  gh pr merge "$1" --merge 2>&1 | tail -1
  s=$(gh pr view "$1" --json number,state -q '"#\(.number) \(.state)"')
  case "$s" in *MERGED) echo "MERGED $1 $s";; *) echo "NOT-MERGED $1 $s";; esac
}

push_branch() { # $1 branch; HEAVY because a pre-push hook may typecheck
  local out
  heavy_acquire "push:$1"; out=$(git push -u origin "$1" 2>&1); heavy_release
  echo "$out" | grep -v '^remote:' | tail -1
  ! echo "$out" | grep -q "error: failed to push"
}

case "$mode" in
  build)
    fresh_train_tree; board "$@"; build_tree ;;
  assemble)
    fresh_train_tree; board "$@" ;;
  typebuild)
    cd "$T" && build_tree ;;
  shiptrain)
    name="$1"; title="$2"; body="$3"
    cd "$T" || exit 1
    git fetch -q origin "$B"
    if ! git merge-base --is-ancestor "origin/$B" HEAD; then
      pre=$(git rev-parse HEAD)
      if ! c=$(union_merge "origin/$B"); then echo "CONFLICT train vs $B: $(echo $c)"; exit 0; fi
      echo "merged new origin/$B into train"
      if git diff --name-only "$pre" HEAD | grep -qvE '\.md$'; then typecheck_tree || exit 0; fi
    fi
    git checkout -q -B "$name"
    bodies=$(git diff --name-only --diff-filter=AM "origin/$B...HEAD" | grep -E '(^|/)artifacts/pr-body\.md$' || true)
    [ -n "$bodies" ] && git rm --cached -q $bodies && git commit -qm "chore: stop tracking PR body files" && echo "untracked PR body files: $(echo $bodies)"
    format_and_commit
    push_branch "$name" || { echo "FAIL push"; exit 0; }
    open_and_merge "$name" "$title" "$body"
    git checkout -q --detach ;;
  ship)
    for item in "$@"; do
      wt="${item%%|*}"; title="${item#*|}"
      cd "$wt" || { echo "FAIL cd $wt"; continue; }
      b=$(git branch --show-current); echo "== $b"
      git fetch -q origin "$B"
      if ! c=$(union_merge "origin/$B"); then echo "CONFLICT $b: $(echo $c)"; continue; fi
      format_and_commit
      push_branch "$b" || { echo "FAIL push $b"; continue; }
      open_and_merge "$b" "$title" artifacts/pr-body.md
    done ;;
  *)
    sed -n '2,10p' "$0"; exit 2 ;;
esac
