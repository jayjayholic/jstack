# Worker clause

Paste at the end of every coding agent's prompt while a train runs; fill the orchestrator id.

---

Shipping (train system):
- Work in your own worktree (`bash {{JSTACK_TOOLS}}/new-worktree.sh <branch> --install`), never in the main checkout.
- You never run a production build. Prove your work with your tests (`{{TEST_CMD}}`, local test resources only) and a check of what you touched; the one full typecheck runs in the train. If you truly need a full typecheck, it takes the shared slot (`source {{JSTACK_TOOLS}}/heavy-lock.sh; heavy_acquire <name>; heavy_capped "{{TYPECHECK_CMD}}"; heavy_release`), never beside a build.
- Screenshots and visual checks run on the component gallery (`{{GALLERY_CMD}}`), not on a production build. Live tests happen on the integration deploy after the merge. The one exception is a pre-merge proof that must run your branch's built code: ask the main session first, then one build, inside the slot and capped (`heavy_acquire <name>; heavy_capped "{{BUILD_CMD}}"; heavy_release`).
- Only builds and typechecks hold the slot. Before starting any server, run `source {{JSTACK_TOOLS}}/heavy-lock.sh; server_wait {{MIN_FREE_GB}}` (waits until no build holds the slot and {{MIN_FREE_GB}} GB RAM is free). Avoid hot-reload dev servers. Stop your server and browser right after each test, before editing code.
- Commit atomically (Conventional Commits). Never push, open a PR or merge. Never use `git stash` / `git stash pop`: the stash stack is shared by every worktree; set work aside with a WIP commit.
- Write the PR body from `{{PR_TEMPLATE}}` to `artifacts/pr-body.md` (untracked).
- User-facing UI: READY only with screenshots, a layout and contrast (WCAG AA) check at zero findings, and the current UI unchanged with your feature flag off. New design: stop after the screenshots and report to the main session; send READY only after it says the owner approved.
- When ready, send exactly `READY FOR BUILD: <worktree path> - <PR title>` via SendMessage to: '<orchestrator id>', then report to the main session in under 150 words.
