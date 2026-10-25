#!/usr/bin/env bash
# READY gate: the checks a train orchestrator runs before it accepts a worker's READY. Not a hook; call it.
# Usage: bash ready-gate.sh <worktree> [--base origin/<branch>] [--brief <file>] [--no-brief]
#   1. the tree is committed (tracked files clean), so the checks below are about the final commit
#   2. typecheck green on that commit: tc_run "$JSTACK_TYPECHECK_CMD", cached per commit SHA, so a worker that already
#      ran the gate makes the orchestrator's run instant
#   3. unit tests for touched files: touched test files plus the test next to each touched file
#      ($JSTACK_UNIT_TEST_CMD <files>; skipped with a note when empty)
#   4. prettier --check on touched files ($JSTACK_PRETTIER_CHECK_CMD)
#   5. the brief checklist is ticked: <worktree>/.agent/brief.md (or --brief) has no "- [ ]" and at least one "- [x]"
#   6. optional $JSTACK_READY_EXTRA_CMD, run in the worktree with the touched files in $READY_TOUCHED (one per line)
#   7. pre-flight present: .agent/preflight.md with the sections its tier needs ($JSTACK_READY_PREFLIGHT off|warn|block)
#   8. unslop gate: static red flags on the lines this branch added ($JSTACK_READY_UNSLOP off|warn|block; block only
#      stops on rules that earned it, see skills/unslop/SELF-EVAL.md); cached per commit SHA
#   9. memory anchors: entries anchored in touched files are FRESH or re-anchored in this branch, only when the repo
#      has .jstack/memory ($JSTACK_READY_MEMORY off|warn|block)
# Exit 0 = READY accepted, 1 = refused (the output says which check), 2 = usage.
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/jstack-env.sh"

wt="" base="origin/$JSTACK_INTEGRATION_BRANCH" brief="" use_brief=1
while [ $# -gt 0 ]; do
  case "$1" in
    --base) base="$2"; shift 2 ;;
    --brief) brief="$2"; shift 2 ;;
    --no-brief) use_brief=0; shift ;;
    -h|--help) sed -n '2,18p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) wt="$1"; shift ;;
  esac
done
[ -n "$wt" ] && [ -d "$wt" ] || { echo "usage: ready-gate.sh <worktree> [--base ref] [--brief file] [--no-brief]" >&2; exit 2; }
cd "$wt" || exit 2
brief="${brief:-.agent/brief.md}"

fails=0
pass() { echo "  PASS  $1"; }
fail() { echo "  FAIL  $1"; fails=$((fails + 1)); }
note() { echo "  ----  $1"; }

sha=$(git rev-parse HEAD) || exit 2
stamps="$(git rev-parse --git-dir)/jstack-ready"
mkdir -p "$stamps"
echo "READY gate for $(git branch --show-current) @ ${sha:0:9} (base $base)"

# 1. committed
dirty=$(git status --porcelain --untracked-files=no)
if [ -z "$dirty" ]; then pass "tree committed"; else fail "uncommitted changes, commit them first:"; echo "$dirty" | sed 's/^/          /' | head -10; fi

mapfile -t touched < <(git diff --name-only --diff-filter=ACMR "$base"...HEAD 2>/dev/null)
[ ${#touched[@]} -eq 0 ] && note "no files differ from $base (wrong --base?)"

# 2. typecheck on this commit
if [ -f "$stamps/$sha.tc.ok" ]; then
  pass "typecheck green on ${sha:0:9} (cached)"
elif [ -n "$dirty" ]; then
  fail "typecheck skipped: the tree isn't committed"
else
  # shellcheck disable=SC1090
  . "$JSTACK_LOCK_SCRIPT"
  log="$stamps/$sha.tc.log"
  if tc_run "$JSTACK_TYPECHECK_CMD" >"$log" 2>&1; then touch "$stamps/$sha.tc.ok"; pass "typecheck green on ${sha:0:9}"
  else fail "typecheck red on ${sha:0:9}, last lines of $log:"; tail -15 "$log" | sed 's/^/          /'; fi
fi

# 3. unit tests for touched files
tests=()
for f in "${touched[@]}"; do
  case "$f" in
    *.test.*|*.spec.*) tests+=("$f"); continue ;;
  esac
  case "$f" in *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs) ;; *) continue ;; esac
  d=$(dirname "$f"); b=$(basename "$f"); stem="${b%.*}"; ext="${b##*.}"
  for c in "$d/$stem.test.$ext" "$d/$stem.spec.$ext" "$d/__tests__/$stem.test.$ext" "$d/$stem.test.ts" "$d/$stem.test.tsx"; do
    [ -f "$c" ] && tests+=("$c")
  done
done
mapfile -t tests < <(printf '%s\n' "${tests[@]+"${tests[@]}"}" | awk 'NF && !seen[$0]++')
if [ ${#tests[@]} -eq 0 ]; then
  note "no unit tests touch the changed files"
elif [ -z "$JSTACK_UNIT_TEST_CMD" ]; then
  note "${#tests[@]} touched test file(s), JSTACK_UNIT_TEST_CMD not set, not run"
else
  log="$stamps/$sha.unit.log"
  if $JSTACK_UNIT_TEST_CMD "${tests[@]}" >"$log" 2>&1; then pass "unit tests (${#tests[@]} file(s))"
  else fail "unit tests red, last lines of $log:"; tail -20 "$log" | sed 's/^/          /'; fi
fi

# 4. prettier on touched files
fmt=()
for f in "${touched[@]}"; do
  case "$f" in *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.json|*.css|*.scss|*.md|*.mdx|*.yml|*.yaml|*.html) [ -f "$f" ] && fmt+=("$f") ;; esac
done
if [ ${#fmt[@]} -eq 0 ] || [ -z "$JSTACK_PRETTIER_CHECK_CMD" ]; then
  note "prettier: nothing to check"
elif out=$($JSTACK_PRETTIER_CHECK_CMD "${fmt[@]}" 2>&1); then pass "prettier (${#fmt[@]} file(s))"
else fail "prettier, run it with --write on:"; echo "$out" | grep -iE '\[warn\]|error' | head -15 | sed 's/^/          /'; fi

# 5. brief checklist
if [ "$use_brief" = 0 ]; then
  note "brief checklist skipped (--no-brief)"
elif [ ! -f "$brief" ]; then
  fail "no brief checklist at $brief (copy the brief's items there as - [ ] lines and tick each with evidence)"
else
  open=$(grep -cE '^\s*[-*] \[ \]' "$brief"); done=$(grep -ciE '^\s*[-*] \[x\]' "$brief")
  if [ "$open" -eq 0 ] && [ "$done" -gt 0 ]; then pass "brief checklist ($done item(s) ticked)"
  else fail "brief checklist: $open open, $done ticked in $brief"; grep -E '^\s*[-*] \[ \]' "$brief" | head -10 | sed 's/^/          /'; fi
fi

# 6. project extra
if [ -n "$JSTACK_READY_EXTRA_CMD" ]; then
  if READY_TOUCHED="$(printf '%s\n' "${touched[@]+"${touched[@]}"}")" bash -c "$JSTACK_READY_EXTRA_CMD"; then pass "extra: $JSTACK_READY_EXTRA_CMD"
  else fail "extra: $JSTACK_READY_EXTRA_CMD"; fi
fi

# warn/block helper for the discipline checks: block counts as a failure, warn only prints
soft() { if [ "$1" = block ]; then fail "$2"; else note "WARN $2"; fi; }

# 7. pre-flight
if [ "$JSTACK_READY_PREFLIGHT" != off ]; then
  pf=".agent/preflight.md"
  if [ ! -f "$pf" ]; then
    soft "$JSTACK_READY_PREFLIGHT" "no pre-flight at $pf (run /preflight; tier S takes about 3 minutes)"
  elif cls=$(head -1 "$pf" | sed -nE 's/.*class: *(quick|light).*/\1/p') && [ -n "$cls" ]; then
    if [ "$cls" = quick ]; then pass "pre-flight (class quick: $(head -1 "$pf" | sed -E 's/.*class: *quick *-? *//' | cut -c1-60))"
    else
      missing=()
      for k in ask check scope; do grep -qiE "^$k:" "$pf" || missing+=("$k:"); done
      if [ ${#missing[@]} -eq 0 ]; then pass "pre-flight (class light)"
      else soft "$JSTACK_READY_PREFLIGHT" "light pre-flight lacks: ${missing[*]}"; fi
    fi
  else
    tier=$(head -1 "$pf" | sed -nE 's/.*tier: *([SML]).*/\1/p'); tier=${tier:-S}
    need=("Ask" "Domains" "Answers" "Acceptance checks" "Scope fence")
    [ "$tier" != S ] && need+=("Budgets" "Verification plan")
    [ "$tier" = L ] && need+=("Pre-mortem")
    missing=()
    for s in "${need[@]}"; do grep -qE "^## $s" "$pf" || missing+=("$s"); done
    if [ ${#missing[@]} -eq 0 ]; then pass "pre-flight (tier $tier)"
    else soft "$JSTACK_READY_PREFLIGHT" "pre-flight tier $tier lacks: ${missing[*]}"; fi
  fi
fi

# 8. unslop gate
if [ "$JSTACK_READY_UNSLOP" != off ]; then
  if [ -f "$stamps/$sha.unslop.ok" ]; then pass "unslop gate on ${sha:0:9} (cached)"
  else
    log="$stamps/$sha.unslop.log"
    if node "$JSTACK_TOOLS/unslop/gate.mjs" --repo . --base "$base" --mode "$JSTACK_READY_UNSLOP" --no-memory >"$log" 2>&1; then
      touch "$stamps/$sha.unslop.ok"; pass "unslop gate ($(tail -1 "$log" | sed 's/^unslop gate[^:]*: //'))"
      grep -E '^warn ' "$log" | head -8 | sed 's/^/          /'
    else fail "unslop gate blocked, see $log:"; grep -E '^(BLOCK|warn) ' "$log" | head -12 | sed 's/^/          /'; fi
  fi
fi

# 9. memory anchors
if [ "$JSTACK_READY_MEMORY" != off ] && [ -d .jstack/memory ]; then
  log="$stamps/$sha.memory.log"
  if node "$JSTACK_TOOLS/memory/memory.mjs" check --changed --base "$base" --repo . >"$log" 2>&1; then pass "memory anchors"
  else soft "$JSTACK_READY_MEMORY" "memory anchors moved by this branch, re-anchor them (memory.mjs reanchor) or retire them:"; tail -12 "$log" | sed 's/^/          /'; fi
fi

if [ "$fails" -eq 0 ]; then
  echo "READY accepted: ${sha:0:9}"; date > "$stamps/$sha.ready"; exit 0
fi
echo "READY refused: $fails check(s) failed. Fix, commit, run the gate again."
exit 1
