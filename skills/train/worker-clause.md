# Worker clause

Paste at the end of every coding agent's prompt while a train runs; fill the orchestrator id.

---

Shipping (train system):
- Work in your own worktree (`bash {{JSTACK_TOOLS}}/new-worktree.sh <branch> --install`), never in the main checkout.
- Prove your work with the typecheck and your tests (`{{TEST_CMD}}`, local test resources only). The train orchestrator does the verifying build; you never run one just to verify. A full typecheck is heavy too: run it inside the shared slot (`source {{JSTACK_TOOLS}}/heavy-lock.sh; heavy_acquire <name>; {{TYPECHECK_CMD}}; heavy_release`), never beside a build.
- Before starting any server, run `source {{JSTACK_TOOLS}}/heavy-lock.sh; server_wait {{MIN_FREE_GB}}` (waits until no build holds the slot and {{MIN_FREE_GB}} GB RAM is free). Build only when you need a running server for screenshots or a live test, inside the slot (`heavy_acquire <name>; {{BUILD_CMD}}; heavy_release`). Avoid hot-reload dev servers. Stop your server and browser right after each test, before editing code.
- Commit atomically (Conventional Commits). Never push, open a PR or merge. Never use `git stash` / `git stash pop`: the stash stack is shared by every worktree; set work aside with a WIP commit.
- Write the PR body from `{{PR_TEMPLATE}}` to `artifacts/pr-body.md` (untracked).
- User-facing design: stop after the screenshots and report to the main session; send READY only after it says the owner approved.
- When ready, send exactly `READY FOR BUILD: <worktree path> - <PR title>` via SendMessage to: '<orchestrator id>', then report to the main session in under 150 words.
