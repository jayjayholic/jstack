#!/usr/bin/env bash
# Batch train. Usage: train.sh build <wt1> <wt2> ...   -> merges branches onto fresh origin/stage in a train worktree, one typecheck + one build
#                     train.sh ship "<wt>|<title>" ...  -> per branch: merge origin/stage, prettier, push, PR, merge (no rebuild)
set -uo pipefail
R=/c/dev/hakutaku/dashboard
T=${TRAIN_DIR:-$R/.worktrees/coordinator-train}
mode="$1"; shift

union_merge() { # $1 = ref to merge into current HEAD; findings-log-only conflicts are unioned
  local ref="$1" c f t
  c=$(git merge-tree --write-tree --name-only HEAD "$ref" | tail -n +2 | grep -v '^$' | grep -v '^Auto-merging\|^CONFLICT')
  if [ -n "$c" ] && [ "$c" != "docs/technical/harness/findings-log.md" ]; then echo "$c"; return 1; fi
  git merge --no-edit "$ref" >/dev/null 2>&1
  if [ -n "$c" ]; then
    f=$c; t=$(mktemp -d); git show :1:$f > $t/b; git show :2:$f > $t/o; git show :3:$f > $t/t
    git merge-file --union $t/o $t/b $t/t; cp $t/o $f; git add $f; git commit -q --no-edit
  fi
  return 0
}

if [ "$mode" = build ]; then
  cd $R && git fetch -q origin stage
  if [ -d "$T" ]; then git -C "$T" merge --abort >/dev/null 2>&1; git -C "$T" checkout -q --detach origin/stage && git -C "$T" reset -q --hard origin/stage && git -C "$T" clean -qfd -e node_modules -e .env.local -e .env.keys -e .env.docker -e .generated; else git worktree add -q --detach "$T" origin/stage; for e in .env.local .env.keys .env.docker; do [ -f $R/$e ] && cp $R/$e $T/; done; fi
  cd "$T"
  for wt in "$@"; do
    b=$(git -C "$wt" branch --show-current)
    if c=$(union_merge "$b"); then echo "TRAIN+ $b"; else echo "TRAIN-CONFLICT $b: $(echo $c)"; fi
  done
  for i in $(seq 1 120); do
    f=$(powershell -NoProfile -Command "[math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB,1)" | tr -d '\r' | tr ',' '.')
    awk "BEGIN{exit !($f>=8)}" && break; sleep 30
  done
  echo "free=$f GB"
  mkdir -p artifacts
  bun install >/dev/null 2>&1
  bun run db:generate > artifacts/train-typecheck.log 2>&1 || { echo "TRAIN-FAIL db:generate"; tail -5 artifacts/train-typecheck.log; exit 0; }
  bun run typecheck >> artifacts/train-typecheck.log 2>&1 || { echo "TRAIN-FAIL typecheck"; grep -E "error TS" artifacts/train-typecheck.log | head -20; exit 0; }
  echo "typecheck PASS"
  r=$(bash /c/dev/hakutaku/tools/coordinator-build.sh "$T" 2>&1 | tail -1); echo "$r"
  case "$r" in PASS*) echo "TRAIN-GREEN";; *) echo "TRAIN-FAIL build"; grep -nE "Error|error" "$T/artifacts/coordinator-build.log" | head -20;; esac
  exit 0
fi

if [ "$mode" = assemble ]; then
  # assemble only (no build): fresh origin/stage + branches
  cd $R && git fetch -q origin stage
  if [ -d "$T" ]; then git -C "$T" merge --abort >/dev/null 2>&1; git -C "$T" checkout -q --detach origin/stage && git -C "$T" reset -q --hard origin/stage && git -C "$T" clean -qfd; else git worktree add -q --detach "$T" origin/stage; for e in .env.local .env.keys .env.docker; do [ -f $R/$e ] && cp $R/$e $T/; done; fi
  cd "$T"
  for wt in "$@"; do
    b=$(git -C "$wt" branch --show-current)
    if c=$(union_merge "$b"); then echo "TRAIN+ $b"; else echo "TRAIN-CONFLICT $b: $(echo $c)"; fi
  done
  exit 0
fi

if [ "$mode" = typebuild ]; then
  # typecheck + build of the already assembled tree in $T
  cd "$T"
  for i in $(seq 1 120); do
    f=$(powershell -NoProfile -Command "[math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB,1)" | tr -d '\r' | tr ',' '.')
    awk "BEGIN{exit !($f>=8)}" && break; sleep 30
  done
  echo "free=$f GB"; mkdir -p artifacts
  bun install >/dev/null 2>&1
  bun run db:generate > artifacts/train-typecheck.log 2>&1 || { echo "TRAIN-FAIL db:generate"; tail -5 artifacts/train-typecheck.log; exit 0; }
  bun run typecheck >> artifacts/train-typecheck.log 2>&1 || { echo "TRAIN-FAIL typecheck"; grep -E "error TS" artifacts/train-typecheck.log | head -20; exit 0; }
  echo "typecheck PASS"
  r=$(bash /c/dev/hakutaku/tools/coordinator-build.sh "$T" 2>&1 | tail -1); echo "$r"
  case "$r" in PASS*) echo "TRAIN-GREEN";; *) echo "TRAIN-FAIL build"; grep -nE "Error|error" "$T/artifacts/coordinator-build.log" | head -20;; esac
  exit 0
fi

if [ "$mode" = shiptrain ]; then
  # usage: shiptrain <train-branch-name> "<PR title>" <body-file>
  name="$1"; title="$2"; body="$3"
  cd "$T"
  git fetch -q origin stage
  if ! git merge-base --is-ancestor origin/stage HEAD; then
    pre=$(git rev-parse HEAD)
    if ! c=$(union_merge origin/stage); then echo "CONFLICT train vs stage: $(echo $c)"; exit 0; fi
    echo "merged new origin/stage into train"
    if git diff --name-only "$pre" HEAD | grep -qvE '\.md$'; then
      bun install >/dev/null 2>&1
      bun run db:generate > artifacts/train-typecheck.log 2>&1 || { echo "FAIL db:generate after stage merge"; exit 0; }
      bun run typecheck >> artifacts/train-typecheck.log 2>&1 || { echo "FAIL typecheck after stage merge"; grep -E "error TS" artifacts/train-typecheck.log | head -20; exit 0; }
      echo "typecheck PASS after stage merge"
    fi
  fi
  git checkout -q -B "$name"
  bodies=$(git diff --name-only --diff-filter=AM origin/stage...HEAD | grep -E '(^|/)artifacts/pr-body\.md$' || true)
  [ -n "$bodies" ] && git rm --cached -q $bodies && git commit -qm "chore: stop tracking PR body files" && echo "untracked PR body files: $(echo $bodies)"
  changed=$(git diff --name-only origin/stage...HEAD -- '*.ts' '*.tsx' | grep -E '^(src|packages|tests)/' || true)
  [ -n "$changed" ] && bunx prettier --write $changed >/dev/null 2>&1 && ! git diff --quiet && git commit -qam "style: format changed files" && echo "formatted"
  out=$(git push -u origin "$name" 2>&1); echo "$out" | grep -v '^remote:' | tail -1
  echo "$out" | grep -q "error: failed to push" && { echo "FAIL push"; exit 0; }
  gh pr view "$name" --json number >/dev/null 2>&1 || gh pr create --base stage --head "$name" --title "$title" --body-file "$body" 2>&1 | tail -1
  for i in 1 2 3 4 5 6; do m=$(gh pr view "$name" --json mergeable -q .mergeable); [ "$m" = "MERGEABLE" ] && break; sleep 10; done
  gh pr merge "$name" --merge 2>&1 | tail -1
  s=$(gh pr view "$name" --json number,state -q '"#\(.number) \(.state)"')
  case "$s" in *MERGED) echo "MERGED $s";; *) echo "NOT-MERGED $s";; esac
  git checkout -q --detach
  exit 0
fi

if [ "$mode" = ship ]; then
  for item in "$@"; do
    wt="${item%%|*}"; title="${item#*|}"
    cd "$wt" || { echo "FAIL cd $wt"; continue; }
    b=$(git branch --show-current); echo "== $b"
    git fetch -q origin stage
    if ! c=$(union_merge origin/stage); then echo "CONFLICT $b: $(echo $c)"; continue; fi
    changed=$(git diff --name-only origin/stage...HEAD -- '*.ts' '*.tsx' | grep -E '^(src|packages|tests)/' || true)
    [ -n "$changed" ] && bunx prettier --write $changed >/dev/null 2>&1 && ! git diff --quiet && git commit -qam "style: format changed files" && echo "formatted"
    out=$(git push -u origin "$b" 2>&1); echo "$out" | grep -v '^remote:' | tail -1
    echo "$out" | grep -q "error: failed to push" && { echo "FAIL push $b"; continue; }
    gh pr view "$b" --json number >/dev/null 2>&1 || gh pr create --base stage --head "$b" --title "$title" --body-file artifacts/pr-body.md 2>&1 | tail -1
    for i in 1 2 3 4 5 6; do m=$(gh pr view "$b" --json mergeable -q .mergeable); [ "$m" = "MERGEABLE" ] && break; sleep 10; done
    gh pr merge "$b" --merge 2>&1 | tail -1
    s=$(gh pr view "$b" --json number,state -q '"#\(.number) \(.state)"')
    case "$s" in *MERGED) echo "MERGED $b $s";; *) echo "NOT-MERGED $b $s";; esac
  done
fi
