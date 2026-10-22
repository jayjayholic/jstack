# ADAPT.md: fit jstack to your stack

This file is written for a coding agent. If you're a human, you can follow it too, or just tell your agent "follow ADAPT.md in the jstack repo for my project at <path>".

jstack has two kinds of settings:

- **Placeholders** like `{{BUILD_CMD}}` in `skills/train/*.md`. These are prompts for agents, so they get filled in once, in the installed copy.
- **Env vars** like `JSTACK_BUILD_CMD` read by the scripts in `tools/`. You set them once in `~/.jstack/config.sh` (copy `tools/config.example.sh`). Nothing in the scripts needs editing.

Most settings exist in both forms with the same value. Fill them from the same answers.

Agent: work through the steps in order. Ask the human only when a value can't be found in the repo or the machine (marked "ask" below). Don't change anything in the target project except adding untracked files the human agrees to.

## Step 1: Detect the stack

Run these from the target project's root (call it `<repo>`) and write down the answers.

1. **Package manager.** Look for lockfiles: `bun.lock` / `bun.lockb` (bun), `pnpm-lock.yaml` (pnpm), `yarn.lock` (yarn), `package-lock.json` (npm), `uv.lock` / `poetry.lock` (Python), `Cargo.lock` (Rust), `go.sum` (Go). Several lockfiles: prefer the one CI uses (check `.github/workflows/*.yml`).
2. **Build, typecheck, test, codegen commands.** Read the `scripts` in `package.json` (or `Makefile`, `pyproject.toml`, `justfile`) and the CI workflow steps. CI is the best source: copy the exact commands it runs. Typical ones: `build`, `typecheck` / `tsc --noEmit`, `test`, and codegen such as `prisma generate`, `db:generate`, `codegen`, `graphql-codegen`.
3. **Branches.** `git remote show origin` gives the default branch. Look for an integration branch PRs target (`stage`, `staging`, `develop`): check open PRs with `gh pr list --json baseRefName` and the CI triggers. If PRs go straight to `main`, the integration branch is `main`. The protected branch is the one that ships to production (ask if unsure).
4. **Local-only files.** Untracked files every checkout needs: `git status --ignored --short` in the main checkout, filtered to env and config files (`.env*`, `.vercel/`, `.dev.vars`, local certs). Never print their contents.
5. **OS.** `uname -s`: `Linux`, `Darwin` (macOS) or `MINGW*`/`MSYS*` (Windows with Git Bash). `heavy-lock.sh` picks the free RAM check by itself (`/proc/meminfo`, `vm_stat` or PowerShell). If none works, set `JSTACK_FREE_GB_CMD` to a command that prints free GB.
6. **RAM.** Linux `free -g`, macOS `sysctl hw.memsize`, Windows `powershell -c "(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory/1GB"`. Then measure one build: run it once and watch peak memory (`/usr/bin/time -v` on Linux, Task Manager or `Get-Process` on Windows). `MIN_FREE_GB` should be about that peak plus 2 to 3 GB.
7. **Deploys.** Does merging to the integration branch deploy somewhere? Look for Vercel/Netlify/Fly config, deploy workflows, or GitHub deployments (`gh api repos/<owner>/<repo>/deployments --jq '.[0]'`). This gives `DEPLOY_CHECK`.
8. **PR template.** `.github/pull_request_template.md` or `.github/PULL_REQUEST_TEMPLATE/*.md`. None: the orchestrator writes a short body per branch.

## Step 2: Fill every value

| Placeholder | Env var | What it means | How to find it | Example |
|---|---|---|---|---|
| `{{JSTACK_TOOLS}}` | `JSTACK_TOOLS` | Folder where the jstack scripts live | Wherever you copy `tools/` in step 3 | `$HOME/jstack-tools` |
| `{{LOCK_DIR}}` | `JSTACK_LOCK_DIR` | The one heavy slot, a directory created and removed by the lock. Must be the same for every agent on the machine | Any path all agents can write; not inside a worktree | `$HOME/.jstack/heavy-lock` |
| `{{REPO_ROOT}}` | `JSTACK_REPO_ROOT` | Main checkout of the project | `git rev-parse --show-toplevel` in the main checkout | `$HOME/code/my-app` |
| `{{WORKTREES_DIR}}` | `JSTACK_WORKTREES_DIR` | Where agent worktrees and the train worktree go. Add it to `.gitignore` if it's inside the repo | Default `<repo>/.worktrees` | `$HOME/code/my-app/.worktrees` |
| `{{INTEGRATION_BRANCH}}` | `JSTACK_INTEGRATION_BRANCH` | Branch trains merge into | Step 1.3 | `stage` |
| `{{PROTECTED_BRANCH}}` | (none) | Branch agents must never push to | Step 1.3, ask if unsure | `production` |
| `{{INSTALL_CMD}}` | `JSTACK_INSTALL_CMD` | Install dependencies | Step 1.1 | `bun install` |
| `{{CODEGEN_CMD}}` | `JSTACK_CODEGEN_CMD` | Generated code the build needs. In markdown write `none` if there isn't any; leave the env var empty | Step 1.2 | `bun run db:generate` |
| `{{TYPECHECK_CMD}}` | `JSTACK_TYPECHECK_CMD` | Full typecheck (or the closest "does it compile" check) | Step 1.2 | `bun run typecheck` |
| `{{BUILD_CMD}}` | `JSTACK_BUILD_CMD` | The production build, exactly as CI runs it | Step 1.2 | `rm -rf .next && bunx next build --turbopack` |
| `{{TEST_CMD}}` | (none) | How a worker runs its own tests | Step 1.2 | `bun test` |
| `{{LOCAL_ENV_FILES}}` | `JSTACK_LOCAL_ENV_FILES` | Untracked files every worktree needs, space separated. Folders go in `JSTACK_LOCAL_DIRS` | Step 1.4 | `.env.local .env.keys` |
| `{{UNION_FILES}}` | `JSTACK_UNION_FILES` | Append-only files where a conflict keeps both sides (logs, changelogs). In markdown write `none` if there aren't any | Ask, or look for files many branches append to | `docs/decisions-log.md` |
| `{{MIN_FREE_GB}}` | `JSTACK_MIN_FREE_GB` | Free RAM needed before a build or a server starts | Step 1.6 | `8` |
| `{{DEPLOY_CHECK}}` | (none) | A command that says whether the latest deploy of the integration branch is Ready | Step 1.7. No deploys: write `no deploy, the merge is the end` | `gh api "repos/<owner>/<repo>/deployments?ref=stage&per_page=1" --jq '.[0].id'` then its `/statuses` |
| `{{PR_TEMPLATE}}` | `JSTACK_PR_TEMPLATE` | PR body template | Step 1.8 | `.github/pull_request_template.md` |
| `{{AGENT_CAP}}` | (none) | Max agents running at once, orchestrator included | Ask. Rough guide: free RAM after the OS divided by the heaviest agent's footprint | `13` |
| `{{BACKLOG_FILE}}` | (none) | Where work waits when the cap is reached. Untracked is fine | Ask | `docs/backlog.md` |

Optional env vars with good defaults: `JSTACK_TRAIN_DIR` (train worktree, default `<worktrees>/train`), `JSTACK_FORMAT_CMD` (formatter run before a train PR), `JSTACK_HEAP_MB` (Node heap cap inside the slot, default 4096), `JSTACK_STALE_MINUTES` (default 45, keep it above your longest build), `JSTACK_FREE_GB_CMD`, `JSTACK_CONFIG` (path of the config file).

## Step 3: Install

1. Tools:
   ```bash
   mkdir -p "$HOME/jstack-tools" && cp <jstack>/tools/* "$HOME/jstack-tools/"
   mkdir -p "$HOME/.jstack" && cp "$HOME/jstack-tools/config.example.sh" "$HOME/.jstack/config.sh"
   ```
   Edit `~/.jstack/config.sh` with the values from step 2.
2. Skill. User-wide for Claude Code:
   ```bash
   mkdir -p ~/.claude/skills && cp -r <jstack>/skills/train ~/.claude/skills/
   ```
   For one project only, use `<repo>/.claude/skills/train` instead. Other agents (Codex, Cursor and friends): put the three files wherever that tool reads skills or rules from.
3. Fill the placeholders in the installed copy only (never in the jstack clone, so `git pull` stays clean). Replace each `{{NAME}}` with its value from step 2, for example:
   ```bash
   cd ~/.claude/skills/train
   sed -i 's|{{INTEGRATION_BRANCH}}|stage|g; s|{{JSTACK_TOOLS}}|'"$HOME"'/jstack-tools|g' *.md
   ```
   On macOS use `sed -i ''`. Values with `|` or `&` in them need escaping, or edit by hand.
4. Add the worktrees folder to the project's `.gitignore` if it lives inside the repo.

## Step 4: Wire the briefs

- Put the filled `worker-clause.md` at the end of every coding agent's prompt. If the project has a CLAUDE.md or AGENTS.md, add one line there: "When a train runs, follow ~/.claude/skills/train/worker-clause.md".
- The filled `orchestrator-brief.md` is the prompt for the one orchestrator agent. `/train` launches it.
- If a pre-push hook typechecks, the push is heavy too. `train.sh` already pushes inside the slot; tell humans to do the same.
- Windows only, optional: start the memory watcher in a background PowerShell: `powershell -NoProfile -File "$HOME/jstack-tools/node-memory-watch.ps1" -LimitGB 5 -PressurePercent 98`. Pick `LimitGB` a bit above your biggest normal build.

## Step 5: Verify

Run each check and fix what fails.

- [ ] No placeholder left in the installed skill: `grep -rn "{{" ~/.claude/skills/train` prints nothing.
- [ ] The config loads: `bash -c 'source ~/jstack-tools/heavy-lock.sh; echo "$JSTACK_REPO_ROOT $JSTACK_INTEGRATION_BRANCH $JSTACK_LOCK_DIR"'` prints your values.
- [ ] RAM check works: `bash -c 'source ~/jstack-tools/heavy-lock.sh; jstack_free_gb'` prints a plausible number (not empty, not 0 on an idle machine).
- [ ] The slot works:
  ```bash
  source ~/jstack-tools/heavy-lock.sh
  heavy_acquire test && ls "$JSTACK_LOCK_DIR" && heavy_release && [ ! -d "$JSTACK_LOCK_DIR" ] && echo slot-ok
  ```
- [ ] `server_wait` returns at once when nothing holds the slot: `bash -c 'source ~/jstack-tools/heavy-lock.sh; server_wait 1 && echo server-wait-ok'`.
- [ ] A worktree comes out ready: `bash ~/jstack-tools/new-worktree.sh jstack-smoke-test`, check the local env files were copied, then `git -C <repo> worktree remove <path>` and `git -C <repo> branch -D jstack-smoke-test`.
- [ ] The build runs inside the slot: `bash ~/jstack-tools/coordinator-build.sh <a worktree>` prints `PASS`.
- [ ] Tell the human what was filled in, especially anything you guessed.
