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
| `{{QUEUE_FILE}}` | (none) | The orchestrator's queue (in flight, boarding, ready, held), read by `/train-queue`. Outside the worktrees, untracked | Any path all agents can read | `$HOME/.jstack/train-queue.md` |
| `{{GALLERY_CMD}}` | (none) | Fast component gallery where agents screenshot UI without a production build | `storybook`, `ladle`, a Vite preview page in the repo. None: write `none, screenshots wait for the integration deploy` | `npm run storybook -- --ci -p 6006` |
| (none) | `JSTACK_CAP_GB` | Hard RAM ceiling for the whole build process tree (`heavy_capped`). Counts committed memory, so set it well above what Task Manager shows | Run one build with `heavy_capped` at a low cap, raise it until it passes, add a margin | `12` |
| (none) | `JSTACK_BUILD_ENV` | Env vars for capped builds and typechecks, space separated. Use it to cap the build tool's workers | Find how your build tool picks its worker count (in its source, not a blog). Next.js: CPU count minus 1, or `CIRCLE_NODE_TOTAL` minus 1 | `CIRCLE_NODE_TOTAL=5` |
| (none) | `JSTACK_TRAIN_BUILD` | `local`: the train builds before the PR. `deploy`: the integration deploy is the build check, and a local build only reproduces a failed deploy | `deploy` only if merging to the integration branch runs a real build somewhere (step 1.7) | `deploy` |
| (none) | `JSTACK_CODEGEN_INPUTS` | Paths in the repo the generated code depends on (git tree hashes are compared) | The codegen tool's input: schema folder, plus the lockfile (the generator version matters) | `prisma bun.lock` |
| (none) | `JSTACK_CODEGEN_REQUIRED` | Generated files or folders that must exist and be non-empty in a sibling (and in the copy) before reuse counts. Catches a sibling caught mid-codegen | Every separate client your codegen writes (ORM client, typed SQL, API types) | `.generated/client .generated/sql` |
| (none) | `JSTACK_TC_SLOTS` / `JSTACK_TC_CAP_GB` | Typecheck lane for worker agents (`tc_run`): how many run at once, and the RAM ceiling for each | One typecheck's peak (watch it once), times the slots, must fit next to the heavy slot. Default 2 and 8 | `2` / `8` |
| (none) | `JSTACK_CODEGEN_REUSE_PATHS` | Generated folders a new worktree may copy from a sibling with identical inputs instead of running codegen | Where `{{CODEGEN_CMD}}` writes. Leave empty to always run codegen | `node_modules/.prisma` |

Optional env vars with good defaults: `JSTACK_TRAIN_DIR` (train worktree, default `<worktrees>/train`), `JSTACK_FORMAT_CMD` (formatter run before a train PR), `JSTACK_HEAP_MB` (Node heap cap inside the slot, default 4096), `JSTACK_STALE_MINUTES` (default 45, keep it above your longest build), `JSTACK_CAP_GB` (default 12), `JSTACK_TRAIN_BUILD` (default `local`), `JSTACK_FREE_GB_CMD`, `JSTACK_CONFIG` (path of the config file).

About the RAM ceiling: on Windows `heavy_capped` uses a Job Object (`run-capped.ps1`), tested. On Linux it uses `systemd-run --user --scope -p MemoryMax=<cap>G`, which needs a systemd user session; that path is UNVERIFIED, so run the check in step 5 before trusting it. On macOS (and Linux without systemd) there is no tree-wide cap: `ulimit -v` limits each process on its own and macOS mostly ignores it, so `heavy_capped` runs the command uncapped and says so. There, the worker cap (`JSTACK_BUILD_ENV`) and the one slot are your protection.

## Step 3: Install

1. Tools:
   ```bash
   mkdir -p "$HOME/jstack-tools" && cp <jstack>/tools/* "$HOME/jstack-tools/"
   mkdir -p "$HOME/.jstack" && cp "$HOME/jstack-tools/config.example.sh" "$HOME/.jstack/config.sh"
   ```
   Edit `~/.jstack/config.sh` with the values from step 2.
2. Skill. User-wide for Claude Code:
   ```bash
   mkdir -p ~/.claude/skills && cp -r <jstack>/skills/train <jstack>/skills/train-queue ~/.claude/skills/
   ```
   For one project only, use `<repo>/.claude/skills/` instead. Other agents (Codex, Cursor and friends): put the three files wherever that tool reads skills or rules from.
3. Fill the placeholders in the installed copy only (never in the jstack clone, so `git pull` stays clean). Replace each `{{NAME}}` with its value from step 2, for example:
   ```bash
   cd ~/.claude/skills
   sed -i 's|{{INTEGRATION_BRANCH}}|stage|g; s|{{JSTACK_TOOLS}}|'"$HOME"'/jstack-tools|g' train/*.md train-queue/*.md
   ```
   On macOS use `sed -i ''`. Values with `|` or `&` in them need escaping, or edit by hand.
4. Add the worktrees folder to the project's `.gitignore` if it lives inside the repo.

## Step 4: Wire the briefs

- Put the filled `worker-clause.md` at the end of every coding agent's prompt. If the project has a CLAUDE.md or AGENTS.md, add one line there: "When a train runs, follow ~/.claude/skills/train/worker-clause.md".
- The filled `orchestrator-brief.md` is the prompt for the one orchestrator agent. `/train` launches it.
- Pre-push hooks: if one only repeats what CI runs (typecheck, lint, tests), suggest deleting it to the human. While one exists, a push is heavy, and `train.sh` pushes inside the slot.
- Worker agents typecheck through `tc_run "<typecheck>"` before READY, never outside the lane. If your typecheck tool has an incremental mode, use it in `JSTACK_TYPECHECK_CMD`: the train only needs cross-branch errors.
- Wire the heavy commands through `heavy_capped` wherever humans or other scripts build: `heavy_acquire <name>; heavy_capped "<build>"; heavy_release`.
- The main session runs the watch from section 6 of the train skill (RAM, build workers, silent agents, orphans, the slot).
- Windows only, optional: start the memory watcher in a background PowerShell: `powershell -NoProfile -File "$HOME/jstack-tools/node-memory-watch.ps1" -LimitGB 5 -PressurePercent 95`. Pick `LimitGB` a bit above your biggest normal build. `-Protect` (default `claude`) is a pattern for command lines that are never killed; set it to match your agent CLI.

## Step 5: Verify

Run each check and fix what fails.

- [ ] No placeholder left in the installed skills: `grep -rn "{{" ~/.claude/skills/train ~/.claude/skills/train-queue` prints nothing.
- [ ] The config loads: `bash -c 'source ~/jstack-tools/heavy-lock.sh; echo "$JSTACK_REPO_ROOT $JSTACK_INTEGRATION_BRANCH $JSTACK_LOCK_DIR"'` prints your values.
- [ ] RAM check works: `bash -c 'source ~/jstack-tools/heavy-lock.sh; jstack_free_gb'` prints a plausible number (not empty, not 0 on an idle machine).
- [ ] The slot works:
  ```bash
  source ~/jstack-tools/heavy-lock.sh
  heavy_acquire test && ls "$JSTACK_LOCK_DIR" && heavy_release && [ ! -d "$JSTACK_LOCK_DIR" ] && echo slot-ok
  ```
- [ ] `server_wait` returns at once when nothing holds the slot: `bash -c 'source ~/jstack-tools/heavy-lock.sh; server_wait 1 && echo server-wait-ok'`.
- [ ] The typecheck lane runs: `bash -c 'source ~/jstack-tools/heavy-lock.sh; tc_run "echo lane-ok"'` prints `lane-ok` and leaves no `<lock dir>-tc-*` folder behind.
- [ ] The RAM ceiling bites: `bash -c 'source ~/jstack-tools/heavy-lock.sh; JSTACK_CAP_GB=1 heavy_capped "node -e \"const a=[];for(;;)a.push(Buffer.alloc(1e8,1))\""'` fails with an allocation error (and prints `run-capped: ... peak` on Windows) instead of eating your RAM. On macOS it says "running uncapped": stop it with Ctrl+C.
- [ ] A worktree comes out ready: `bash ~/jstack-tools/new-worktree.sh jstack-smoke-test`, check the local env files were copied, then `git -C <repo> worktree remove <path>` and `git -C <repo> branch -D jstack-smoke-test`.
- [ ] The build runs inside the slot: `bash ~/jstack-tools/coordinator-build.sh <a worktree>` prints `PASS`.
- [ ] Tell the human what was filled in, especially anything you guessed.

## Extra: the /optimize skill

`skills/optimize/SKILL.md` is the speed agent: it measures the built app and staging, ranks what costs the user the most time, fixes the top items and proves each fix with interleaved A/B runs. It reuses the train settings above (`{{JSTACK_TOOLS}}`, `{{BUILD_CMD}}`, `{{TYPECHECK_CMD}}`, `{{TEST_CMD}}`, `{{INSTALL_CMD}}`, `{{CODEGEN_CMD}}`, `{{INTEGRATION_BRANCH}}`, `{{PR_TEMPLATE}}`) plus these:

| Placeholder | What it means | How to find it | Example |
|---|---|---|---|
| `{{APP_URL}}` | Staging (or preview) URL to measure | The deploy config or the latest deployment of the integration branch | `https://staging.example.com` |
| `{{MAIN_ROUTE}}` | The page measured when nobody says what's slow | The app's main screen after sign-in | `/app` |
| `{{SESSION_FILE}}` | Stored signed-in browser session for staging | Ask the human to sign in once in a persistent browser profile and save its state (Playwright `storageState`) | `$HOME/.jstack/staging-session.json` |
| `{{LOCAL_SESSION_CMD}}` | How to get a session for a test user on the local build | The repo's test helpers or seed scripts; ask if none | `npm run test:session -- --out .auth/session.json` |
| `{{SERVER_CMD}}` | Starts the production build locally | `start` script in `package.json` | `npm run start -- -p 3141` |
| `{{PROFILE_SCRIPT}}` | Measures one surface once and writes JSON with the fields in the skill's table | Repo `scripts/perf/` if it exists, else write one (below) | `node scripts/perf/measure-load.mjs` |
| `{{SUITE_SCRIPT}}` | Runs the profile script over every scenario N times | Same | `bash scripts/perf/suite.sh` |
| `{{AB_SCRIPT}}` | Interleaved A/B: before and after builds in ABAB blocks, one server at a time | Same | `bash scripts/perf/ab-blocks.sh` |
| `{{COMPARE_SCRIPT}}` | Summaries (n, median, p75, p95) and the before/after table with Hodges-Lehmann 95% CI and Cliff's delta | Same | `node scripts/perf/compare-runs.mjs` |
| `{{BUNDLE_BUDGET_CMD}}` | First-load JS per route, checked against a budget file | Repo scripts; Next.js prints first-load JS in the build output | `npm run perf:budget` |
| `{{BUNDLE_ANALYZE_CMD}}` | What's inside the bundle, per route | `@next/bundle-analyzer`, `next experimental-analyze` (Next 16), `source-map-explorer`, `vite-bundle-visualizer` | `npx next experimental-analyze --output` |
| `{{PLAYBOOK_FILE}}` | Where runs write baselines, fixes and dead ends | Pick a docs path | `docs/perf/optimize-playbook.md` |

If the repo has no perf scripts yet, the agent writes them before the first run. The minimum that works:

- **Profile script:** Playwright opens the URL with the session, records `PerformanceNavigationTiming` (TTFB, FCP), LCP and Long Animation Frames through `PerformanceObserver`, every `fetch`/XHR with start and duration (for the waterfall), JS bytes from resource timing, and the time until each milestone selector appears. For a click: Event Timing duration (INP) and the time until the target selector appears. It also writes CPU use and free memory (`jstack_free_gb` from `heavy-lock.sh`).
- **A/B script:** for each block, move the arm's build into place, start `{{SERVER_CMD}}`, wait for it, run the suite, stop the server. Order A B A B. Refuse a busy port.
- **Compare script:** per metric, the median and p75 of each arm, the Hodges-Lehmann shift with a 95% interval, a Mann-Whitney p value and Cliff's delta; label `lower` only when the interval excludes 0 and |δ| ≥ 0.147.

Install it like the train skill: `cp -r <jstack>/skills/optimize ~/.claude/skills/`, fill the placeholders in the installed copy, then `grep -rn "{{" ~/.claude/skills/optimize` must print nothing.
