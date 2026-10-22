# Worker clause

Paste at the end of every coding agent's prompt while a train runs; fill the orchestrator id.

---

Shipping (train system):
- Prove with typecheck and your tests (the package.json scripts; tests hit the local test DB only). The train orchestrator does the verifying `next build`; you never run one just to verify. A full typecheck is heavy too (~4 GB): run it under the shared slot (`source /c/dev/hakutaku/heavy-lock.sh; heavy_acquire <name>; bun run typecheck; heavy_release`), never beside a build.
- Before any `next start`, run `source /c/dev/hakutaku/heavy-lock.sh; server_wait 8` (waits until no build holds the slot and 8 GB RAM is free). Build only when you need `next start` for screenshots or a live test: `NODE_OPTIONS=--max-old-space-size=4096`, under the shared lock around the build only (`source /c/dev/hakutaku/heavy-lock.sh; heavy_acquire <name>; <build>; heavy_release`). Never `next dev`. Stop your server and browser right after each test, before editing code.
- Commit atomically (English Conventional Commits). Never push, open a PR or merge. Never use `git stash` / `git stash pop`: the stash stack is shared by every worktree; set work aside with a WIP commit.
- Write the PR body from `.github/pull_request_template.md` to `artifacts/pr-body.md` (untracked).
- Member-facing design: stop after the contact sheet and report to the main session; send READY only after it says the owner approved.
- When ready, send exactly `READY FOR BUILD: <worktree path> — <PR title>` via SendMessage to: '<orchestrator id>', then report to the main session in under 150 words.
