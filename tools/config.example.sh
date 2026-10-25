# Copy to ~/.jstack/config.sh (or point JSTACK_CONFIG at it) and fill in your values.
# Every jstack script reads it. Anything you leave out falls back to the default in jstack-env.sh.
# Example values are the author's own setup (Bun + Next.js on Windows).

export JSTACK_TOOLS="$HOME/jstack-tools"                 # where these scripts live
export JSTACK_LOCK_DIR="$HOME/.jstack/heavy-lock"        # the one heavy slot (a directory, created and removed by the lock)
export JSTACK_REPO_ROOT="$HOME/code/my-app"              # main checkout of the repo the agents work on
export JSTACK_WORKTREES_DIR="$JSTACK_REPO_ROOT/.worktrees" # where agent worktrees and the train worktree go
export JSTACK_INTEGRATION_BRANCH="stage"                 # branch trains merge into
export JSTACK_INSTALL_CMD="bun install"
export JSTACK_SHARED_DEPS=1                              # worktrees link node_modules + generated code to shared stores (worktree-deps.mjs); 0 = own install each
export JSTACK_STORE_INSTALL_CMD="bun install --frozen-lockfile" # how a shared store is built (default derived from JSTACK_INSTALL_CMD)
export JSTACK_CODEGEN_CMD="bun run db:generate"          # leave empty if your build needs no codegen
export JSTACK_TYPECHECK_CMD="bun run typecheck"
export JSTACK_BUILD_CMD="bunx next build --turbopack"
export JSTACK_FORMAT_CMD=""                              # optional, e.g. "bunx prettier --write src" before the PR
export JSTACK_LOCAL_ENV_FILES=".env.local .env.keys"     # untracked files every worktree needs
export JSTACK_LOCAL_DIRS=".vercel"                       # untracked folders every worktree needs
export JSTACK_UNION_FILES=""                             # append-only files where both sides of a conflict are kept
export JSTACK_PR_TEMPLATE=".github/pull_request_template.md"
export JSTACK_MIN_FREE_GB=8                              # free RAM needed before a build or a server starts
export JSTACK_HEAP_MB=4096                               # NODE_OPTIONS heap cap inside the slot
export JSTACK_STALE_MINUTES=45                           # keep above your longest build
export JSTACK_CAP_GB=12                                  # hard RAM ceiling for the whole build process tree (heavy_capped)
export JSTACK_BUILD_ENV="CIRCLE_NODE_TOTAL=5"             # env for capped builds; this one makes Next.js use 4 build workers
export JSTACK_TRAIN_BUILD="deploy"                       # local = the train builds; deploy = the integration deploy is the build check
export JSTACK_CODEGEN_INPUTS="schema bun.lock"           # what generated code depends on (paths in the repo)
export JSTACK_CODEGEN_REUSE_PATHS=".generated"           # generated folders a new worktree may copy from a sibling with the same inputs
export JSTACK_CODEGEN_REQUIRED=".generated/client .generated/sql" # every one must exist and be non-empty in a sibling before it's copied
export JSTACK_TC_SLOTS=2                                 # parallel typecheck lanes for worker agents (tc_run); a tsc peaks ~5 GB
export JSTACK_TC_CAP_GB=8                                # RAM ceiling for each lane's typecheck
export JSTACK_HEAVY_MIN_AVAIL_GB=12                      # free RAM a build waits for once it holds the slot
export JSTACK_TC_MIN_AVAIL_GB=10                         # free RAM a typecheck lane waits for
export JSTACK_MEM_WAIT_MAX_MIN=15                        # after this a memory wait gives up and runs anyway (still capped)
export JSTACK_QUEUE_FILE="$HOME/.jstack/train-queue.md"  # the orchestrator's queue; mem-map reads it to name agents
export JSTACK_LOCK_SCRIPT="$JSTACK_TOOLS/heavy-lock.sh"   # the lock ready-gate.sh sources for tc_run
export JSTACK_UNIT_TEST_CMD="bunx vitest run"            # ready-gate.sh runs it with the touched test files; empty = skip
export JSTACK_PRETTIER_CHECK_CMD="bunx prettier --check --ignore-unknown" # ready-gate.sh, on touched files
export JSTACK_READY_EXTRA_CMD=""                         # optional extra gate check; touched files are in $READY_TOUCHED
