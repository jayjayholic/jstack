# Copy to ~/.jstack/config.sh (or point JSTACK_CONFIG at it) and fill in your values.
# Every jstack script reads it. Anything you leave out falls back to the default in jstack-env.sh.
# Example values are the author's own setup (Bun + Next.js on Windows).

export JSTACK_TOOLS="$HOME/jstack-tools"                 # where these scripts live
export JSTACK_LOCK_DIR="$HOME/.jstack/heavy-lock"        # the one heavy slot (a directory, created and removed by the lock)
export JSTACK_REPO_ROOT="$HOME/code/my-app"              # main checkout of the repo the agents work on
export JSTACK_WORKTREES_DIR="$JSTACK_REPO_ROOT/.worktrees" # where agent worktrees and the train worktree go
export JSTACK_INTEGRATION_BRANCH="stage"                 # branch trains merge into
export JSTACK_INSTALL_CMD="bun install"
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
