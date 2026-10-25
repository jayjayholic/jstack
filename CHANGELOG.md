# Changelog

Each entry says what changed and which problem it fixes.

## 2026-10-24: the train cleans up after itself

**What:** `/train` gets a section 6b.
- Boarded worktrees are removed right after the merge, once they're clean and merged; the branches stay.
- After each release, a leftovers sweep checks seven things:
  - stale worktrees;
  - stray processes;
  - uncommitted work;
  - dangling READYs;
  - stopped containers;
  - temp builds;
  - held slots.
- The sweep removes what's provably done and lists the rest.

**Why:** one repo had 368 worktrees, 354 of them with their own `node_modules`. Every install and git sweep walked all of them, and the file cache paid for it in RAM. Agents end; their worktrees, servers and loops don't.

## 2026-10-24: mem-map, a machine-memory skill, and lock guards that wait for RAM

**What:**
- `tools/mem-map.ps1`, run as `mem_map` from `heavy-lock.sh` (Windows), shows:
  - totals: available, commit, standby, modified, pools, and how much of the "in use" memory is the system file cache;
  - process groups sorted by private bytes;
  - each process tagged with its worktree, branch and agent (`<worktree>/.agent`, the lock owner, the queue file);
  - the WSL VM and `docker stats`;
  - listening dev ports, orphan candidates and lock slots.
- `mem-map.ps1` options:
  - `-Kill orphans` terminates orphan candidates through WMI, never the agent CLI, MCP servers or Docker;
  - `-Watch` appends one CSV row per process per tick;
  - `-Summary` prints each agent's peak and when it happened.
- In `heavy-lock.sh`:
  - `heavy_acquire` waits for `JSTACK_HEAVY_MIN_AVAIL_GB` (12) free once it holds the slot.
  - `tc_run` waits while someone else's build holds the slot, starts at least 90 s after the other lane, then waits for `JSTACK_TC_MIN_AVAIL_GB` (10). A slot held from the same directory counts as yours, so the train can typecheck inside its own build slot.
  - Every wait gives up after `JSTACK_MEM_WAIT_MAX_MIN` (15) and runs anyway, still capped.
  - Owner lines end in `@ <cwd>`; the first word is still the name.
  - New `mem_guard [gb]` helper.
- New `skills/machine-memory/SKILL.md`; the train watch and worker clause point at it.

**Why:** the 32 GB laptop kept hitting 97 to 99% and nobody could say whose fault it was:
- Process lists sort by working set, so the 8 GB typecheck that was paged out looked tiny.
- Agents reported loops as stopped that were still running.
- `taskkill` sometimes refused, while WMI terminate worked.
- The biggest single spike wasn't a process at all: two concurrent installs over hundreds of `node_modules` folders kept 15.8 GB of file cache resident.

Claude Code has no per-subagent resource view, so the map tags each process by worktree. Also, `grep -iF` aborts (core dumped) in Git Bash here, so the lock compares strings in bash.

## 2026-10-24: jay-claude-switcher 0.7.0 switches within a second of 99%, not after the wall

**What:** the switch decides on the readings in hand and never waits for a usage read. Every second it reads the session's own rate-limit numbers (free; every response brings them, main loop, subagents and workflow agents alike) and switches within that second of a bar reaching 99%. From 95% the other accounts are read ahead, once per 5 minutes, so the target is known before it's needed; only when no account has a reading below 99% does a due switch read them, for 4 s at most. A usage answer can no longer lower the session's own (fresher) number for the same window. The new credentials are written first, before the bookkeeping. After a switch, readings that still carry only the old account's windows are not laid over the new one for 10 minutes. And there's a trace now: `switch-trace.log` next to the store, one timestamped line per reading, decision and switch, never a token.

**Why:** the stored usage samples showed the bar at 99% 16 s (and, another time, 44 s) before the first 429, and still no switch until after it. Nobody missed the 99%: the check saw it, then sat waiting behind network reads. From 95% the current account was read every 5 s, and the switch first awaited any read in flight, then read every other account one after another (token refresh included) before writing anything. Meanwhile a lagging usage answer could overwrite the 99% with 97% and call the switch off. A workflow of 13 agents climbs a point every 20 s or so near the top; the switch spent its whole margin on HTTP. The 32 GB laptop was idle the entire time, which for once was the problem.

## 2026-10-24: /optimize learns what a blank screen looks like

**What:** three new rows in `skills/optimize/DEBUG-CHECKS.md`: a screen change that blanks the whole UI (a pending check
drawn in place of the shell, plus a click that renders everything at once), a list that shows up seconds late on some
loads (half its data outside the server preload, a preload budget that drops misses, per-row queries), and local A/B
runs that all time out because the machine is swapping.

**Why:** two real cases from the same day. Opening a thread blanked the header, background and input for half a second
because an app check said "wait" by erasing the whole screen. The side list took up to 4.7 s because half of what it
reads was never preloaded. And the A/B to prove it couldn't run: 2 GB free out of 32. The laptop was, once again, the
bottleneck.

## 2026-10-24: /optimize puts "perceived instant" first

**What:** `skills/optimize/SKILL.md` gains a top-level section, "Perceived instant first", with five rules and the
check an agent runs for each: the shell never unmounts or blanks; anything not instant gets a skeleton in place; the
probable next action is kept warm (server preload, prefetch on render/idle/hover) and refreshed in the background;
cached state is drawn first and reconciled after; time-to-shell, first content and long tasks are measured on every
pass. Saying "this can't be faster" without adding a skeleton now counts as a failed run.

**Why:** the agent kept chasing total load time while the user stared at a side list that took seconds and a screen
that blanked on every thread open. Those were basic perception bugs, and the old skill would happily report "the query
is already fast, nothing to do" and leave the blank screen there. Fast-but-blank is still blank.

## 2026-10-23: /optimize starts from a checklist of what already went wrong

**What:** new `skills/optimize/DEBUG-CHECKS.md`, three tables (method traps, machine traps, known causes), every row
as symptom → how to measure → cause → proven fix → verify. It replaces the dated "What the runs learned" list in the
skill, adds a 1-run smoke of the suite before the baseline, and makes it a standing rule that every run turns each
finding into a row there and an entry in the playbook while it runs.

**Why:** an optimize run spent its first hour learning things earlier runs had already paid for: the suite's selectors
died with a UI redesign, a "click → done" metric finished before the click because the old screen already matched,
a popup ate every click, TBT went "up" because the page painted earlier, two builds at once took the laptop to 2% free
RAM, and six tries at decoding the server HTML with inline regexes. A dated list of anecdotes didn't stop any of it; a
checklist you run before measuring does. The 32 GB laptop thanks you in advance.

## 2026-10-23: jay-claude-switcher switches before the wall, not after it

**What:** the switch now acts on the number on screen: the moment a bar shows 99% (98.5% and up), the next 1-second check switches. To keep that number fresh, the rate-limit numbers are re-read after every response (main loop and every agent), and from 95% the current account's usage is read every 5 s instead of once a minute. After a limit error the status line names where the session went and who to resume (the main conversation and every agent whose turn ended on an error within two minutes). A stored account whose usage read comes back 401 is refreshed with its refresh token and the rotated pair saved; only a refused refresh (`invalid_grant`) marks it logged out, and token calls now send their own User-Agent because the endpoint's firewall refuses some clients' default one.

**Why:** version 0.5.0 did switch, but only after the limit hit, so the running agents died with 429 first and nobody told the owner which ones to wake up. The bar read 98 while the account was already at 99, because the numbers were only refreshed on the main loop and the account was read once a minute. Meanwhile one account showed as dead when it only needed its tokens refreshed (and one really was dead: its refresh token had been rotated by another session). 13 agents, one wall, zero survivors. Not anymore.

## 2026-10-23: jay-claude-switcher switches at 99%, and on the limit error itself

**What:** the auto-switch threshold drops from 99.9% to 99%, and it checks at once on every new reading. The session's own limit error (`StopFailure` with `rate_limit`, or any turn ending on an API error at 98% or more) now marks the account full and switches right away, with a 15 s pause instead of 90 s. A candidate whose last usage read got a 429 keeps its last reading instead of being ruled out; only an expired login rules an account out; with nothing readable below 99%, an account never read gets a try. When there is nowhere to go, the Sessions tab says why. New end-to-end tests drive the plugin through the test engine: crossing 99% switches, a limit error switches, no candidate writes nothing and shows the reason.

**Why:** the first live miss. The session's numbers sat at 99% (they are rounded) while the threshold waited for 99.9%, and the other accounts had just had their usage reads refused with 429, which silently ruled every one of them out. So the account hit the wall, the agents ate 429s, and the switch never moved. The 32 GB laptop was fine. The 13 agents were not.

## 2026-10-23: jay-claude-switcher, a second plugin for juggling Claude accounts

**What:** new plugin in `plugins/jay-claude-switcher/`, listed in the marketplace next to jstack (`/plugin install jay-claude-switcher --marketplace jayjayholic/jstack`). A side panel with a Sessions tab (every stored account, its 5-hour and weekly bars, sorted by nearest reset, Use and Refresh buttons) and an auto-switch that swaps `.credentials.json` to the least-used account when the current one reaches 99.9%. Plus a Work tab (limits with a forecast, running agents, tool calls in flight, task list, context window), `scripts/switch.py` (`save | list | use | next | import`, honours `CLAUDE_CONFIG_DIR`, writes the store owner-only) and an `add-account` skill that logs a new account in through a second Claude Code with its own config folder, so the working session never logs out. The usage endpoint is read only from 98%, at most once a minute, and backs off on 429 (Retry-After, else 5 minutes doubling to 30).

**Why:** 13 agents on one account hit the 5-hour wall at 3 a.m. and die mid-task, and switching accounts by hand means logging out the session they all run in. A running Claude Code re-reads `.credentials.json` when the file changes, so a file swap moves every agent to the next account on its next request. The 32 GB laptop was finally fine; now the rate limiter is too.

## 2026-10-23: /optimize gets a performance know-how file

**What:** new `skills/optimize/PERFORMANCE.md`, and `skills/optimize/SKILL.md` now reads it before measuring and gains a fifth rule, "explain the number". The file has the method (write the claim first, name the limiter, the performance mantras cheapest first, one change and one measurement with a decision log, ABAB with rank statistics, keep behaviour), a 7-question check every number must pass before it's reported, the metric targets (including SPA soft navigations, on by default since Chrome 151), trace recipes per layer that turn every capture into SQL rows (Perfetto, LoAF, web-vitals attribution, React Performance Tracks, `--cpu-prof`, Server-Timing, OpenTelemetry, ORM spans, pg_stat_statements), techniques for instant screens and chat, cases with numbers, how the old rules (Souders, RAIL, PRPL) aged, and every source with its date. The method is adapted from Lauren Tan's [pstack](https://github.com/cursor/plugins/tree/main/pstack) (MIT) and Brendan Gregg's Benchmarking Checklist and USE method, with credit in the file.

**Why:** /optimize knew how to run an A/B, but not how to tell a real number from a fake one. A fix can look faster because the request errored, the cache was warm on one side, the work never ran, or the change saved more time than the code it touched ever took. The research behind this was two separate arms, one agent on primary sources and one research agent, then merged. They disagreed in useful places: clinic.js is no longer maintained, TanStack's `prefetchQuery` is deprecated, and the famous "Amazon 100 ms = 1%" line isn't on the page everyone cites. So it's in here as unverified, not as fact. Also, an agent that knows "don't do it" comes before "do it cheaper" is one fewer `next build` on the 32 GB laptop.

## 2026-10-22: real reds, out-of-memory deploys and one big train

**What:** four new lessons in `skills/train/SKILL.md`. Read every failing line before calling it a flake, and bisect against the previous merges when unsure. When the host build dies with "Killed / exit 137" after an account or billing switch, measure peak memory with one capped local build, then check the host's build machine size through its API (Vercel: `resourceConfig.buildMachineType`) and only change it with the owner's go, since it hits the bill. When the host was blocked, board every waiting ready branch into ONE big train, drop the conflicting ones, ship the rest. And workers never start their own app servers: component gallery and test scripts, one shared server at most.

**Why:** a train merged on a real red because half its failures were dismissed as "worktree state" (one was a real test mock regression). A deploy kept dying out of memory while local builds were green, because the build machine had silently dropped back to standard 8 GB and the build needs about 9.8 GB. A pile of ready branches was about to crawl through many small trains. And a handful of per-worker app servers plus typechecks took the 32 GB laptop down to 2% free RAM.

## 2026-10-22: when GitHub is degraded and the deploy goes quiet

**What:** three new lessons in `skills/train/SKILL.md`. Missing host statuses during a GitHub incident get ONE check with the host CLI (`vercel ls`), never a loop. If no deploy appears about 10 min after a merge, deploy the target branch by hand from a clean `git archive` export (link, delete the pulled `.env.local`, deploy to the env, delete the scratch dir). And editing a file through the GitHub contents API from Git Bash on Windows: build the content from `git show`, base64 it from a file, diff before merging.

**Why:** during a GitHub incident the deploy statuses disappeared while deploys kept running, and another merge got no deploy at all because the webhook never fired. Watching it with a CLI loop once grew to 4 GB. And `jq -r .content | base64 -d` broke on `\r\n` and committed a truncated file without a word of complaint.

## 2026-10-22: what the train does when GitHub Actions won't run

**What:** a new lesson in `skills/train/SKILL.md`: when Actions won't start jobs (credits, billing, spending limit), the train runs the same checks locally (merge-strategy guard, Prettier on changed files, typecheck, unit suites under `heavy_capped`), merges with `gh pr merge --admin` only if all are green, writes the results in the PR body, and confirms the deploy from the commit statuses. Actions-only jobs wait.

**Why:** the credits ran out mid-night and every check failed in 2 s without running anything. The train stood still on a red that wasn't a test result, while the checks it needed are a handful of commands the laptop can run on its own.

## 2026-10-22: copy fix in new-worktree.sh

**What:** reused generated folders and copied local folders are now replaced, not copied into themselves.

**Why:** when the target folder already existed, `cp -r` dropped the copy inside it (`.generated/.generated`), and the agent's typecheck failed on missing generated code.

## 2026-10-22: the numbers, and worktree cleanup

**What:** a short numbers section in the README with a monthly chart GitHub draws itself, and `tools/clean-worktrees.sh`, which removes finished worktrees only when the branch is merged, nothing is uncommitted, nothing runs inside and nothing changed in the last hour.

**Why:** people asked if it actually works. And one night of parallel agents left 275 worktrees on the disk.

## 2026-10-22: the planning skills ship with jstack

**What:** `/grill-me`, `/grilling` and `/wayfinder` (plus the four skills wayfinder calls) are now in `skills/`, copied as-is from [mattpocock/skills](https://github.com/mattpocock/skills) (MIT, licence file in each folder), so `/plugin install` brings them too. `/simplify` gets `skills/simplify/README.md` instead of a copy: it's built into Claude Code and its licence doesn't allow redistributing it, and you already have it anyway. README, HOW-I-WORK.md and AGENTS.md now point at the in-repo copies.

**Why:** the README says plan first, but the planning skills lived in another repo, so people had to install things separately before jstack even made sense. Now it's one install. `/wayfinder` calls Matt's `research`, `prototype` and `domain-modeling` skills and expects an issue tracker set up with his `setup-matt-pocock-skills`, so those four are copied as-is too (same pin, same MIT licence). Nothing else to install.

## 2026-10-22: README says who this is for, and what plan to bring

**What:** a new section near the top of the README: jstack is for detailed, planned and prototyped work (grill the plan, map it with /wayfinder into tickets with dependencies and owned files, prototype the UI, then start the agents), and a recommendation for a Claude Max 20x plan or equivalent high limits.

**Why:** the dependency graph from planning is what makes one agent per chain work. The night the latest rules came from, the planned and prototyped UI flowed while the process changes improvised live cost rework. And with 10 to 13 agents at once, lower limits killed agents mid-task, and each one had to be resumed by hand.

## 2026-10-22: typecheck lane, drop don't fix, chains, and "measure it"

**What:**
- `tc_run "<cmd>"` in `heavy-lock.sh`: a typecheck lane for worker agents, `JSTACK_TC_SLOTS` parallel slots (default 2), each run capped at `JSTACK_TC_CAP_GB` (default 8), separate from the train's heavy slot.
- READY now ends with `typecheck green at <sha>`. New `train.sh board <wt>@<sha>` adds branches to the boarding train (continuous boarding) and refuses a head that moved past that sha.
- The train is a quick merge: one incremental integration typecheck, and a failing branch is dropped and bounced with its errors, never fixed in place or waited on. The boarding train is assembled and typechecked while the other is in CI. Big trains run CI's suites locally before the push. The formatter runs in write mode, resolutions chain their check with `&&`, nobody commits in a worker's live worktree, and bounced branches get a `train/<date>-<n>-wip` base.
- `new-worktree.sh` only reuses generated code from a sibling where every path in the new `JSTACK_CODEGEN_REQUIRED` exists and is non-empty, and checks the copy again, falling back to codegen if it's incomplete.
- The train skill: one agent per dependency chain, gates written before work starts, a bigger watch (orphaned scripts, only `running` agents count, frozen rules, commit as you go), a new section 7 "Measure it" (Little's law and the clean-batch probability), and lessons for deploy-only failures (anchor `.vercelignore` paths), the pre-push hook and rule churn.
- README, ADAPT.md, AGENTS.md, llms.txt and the plugin manifest (0.5.0) follow.

**Why:** after the first batch of rules, 27% of branches still broke the train's typecheck, because agents skipped it and the orchestrator fixed their errors one by one. At that rate a train of 8 is clean 8% of the time. Four parallel typechecks took the laptop to 0.3 GB free, so the lane is capped at two. A reused generated folder copied mid-codegen failed a train with 80 errors. An unanchored `docs/` in `.vercelignore` broke a deploy that every local check called green. And one agent per ticket kept agents waiting on each other: one agent per chain took merged throughput from about 3 to about 27 tickets an hour in one night (part of that was a backlog landing together). Little's law then showed about 20 tickets in flight where 4 would do, so the fix was starting less, not adding agents.

## 2026-10-22: hard RAM ceiling, agents never build, /train-queue

**What:**
- `heavy_capped "<cmd>"` in `heavy-lock.sh` runs a build or typecheck with a hard RAM ceiling on its whole process tree (`JSTACK_CAP_GB`, default 12). On Windows it's a Job Object through the new `tools/run-capped.ps1` (tested: a 1 GB cap stops a runaway allocation at 1 GB). On Linux it uses `systemd-run --user --scope -p MemoryMax`, UNVERIFIED. On macOS it runs uncapped and says so. `coordinator-build.sh` and the train's typecheck use it.
- `JSTACK_BUILD_ENV` passes env to capped builds, mainly to cap the build tool's workers (`CIRCLE_NODE_TOTAL=5` makes Next.js use 4 instead of CPU count minus 1).
- `JSTACK_TRAIN_BUILD=deploy`: the train only typechecks, and the integration deploy is the build check. A local build happens once, capped, only to reproduce a failed deploy.
- Workers never build. Screenshots go on a component gallery (`{{GALLERY_CMD}}`), live tests on the integration deploy, and the full typecheck lives in the train.
- Only builds and typechecks take the slot. `train.sh` takes it for a push only while a pre-push hook exists, and the docs suggest deleting a hook that repeats CI.
- Max two trains: one in CI, one boarding.
- New `/train-queue` skill: a read-only board of what's live, the train in flight, the queue and each agent's job. The orchestrator keeps the queue file (`{{QUEUE_FILE}}`) it reads.
- `new-worktree.sh --install` copies generated code from a sibling worktree when the codegen inputs match (`JSTACK_CODEGEN_INPUTS`, `JSTACK_CODEGEN_REUSE_PATHS`). Each worktree stamps the inputs its code came from, so a sibling whose schema moved after its codegen is never copied.
- The watch (section 6 of the train skill): kill the heaviest process tree below 5% free RAM, never the agent CLI; agents silent for over 60 minutes are suspects; servers left behind by finished agents get killed. `node-memory-watch.ps1` got `-Protect` (default `claude`) so it never kills the agent CLI, and a 95% default.
- README, ADAPT.md, AGENTS.md, llms.txt and the plugin manifest (0.4.0) cover all of the above.

**Why:** with the one-slot rule in place, a single `next build` still took the laptop to 2% free RAM: 19 workers at 0.75 GB each. `NODE_OPTIONS` caps one heap, not a tree, so the only real fix was a ceiling on the whole tree plus fewer workers. Then agents ran about 15 production builds in one night just to take screenshots, and held the slot for screenshot runs and proofs, so trains waited half an hour behind a screenshot. Four trains queued at once tripled the CI runs. And every new worktree regenerated the same ORM client from the same schema. Each rule here is one of those nights, made boring.

## 2026-10-22: findable and installable as a Claude Code plugin

**What:** a Claude Code plugin marketplace (`.claude-plugin/marketplace.json` + `plugin.json`, checked with `claude plugin validate`), so `/plugin marketplace add jayjayholic/jstack` and `/plugin install jstack@jstack` work. When installed that way the skills read `~/.jstack/config.sh` for anything still in placeholders. New `AGENTS.md` (notes for coding agents, per agents.md) and `llms.txt` (a short doc index, per llmstxt.org). The README now says in its first lines what this is and who it's for, with the install lines and a few badges. Skill descriptions name the things people actually search for (parallel agents, git worktrees, merge train, out-of-RAM builds, LCP/INP/TTFB). The GitHub repo got a description and topics. `.gitattributes` keeps the scripts LF on Windows checkouts.

**Why:** the popular skill repos all install with one `/plugin` line and say what they are in the first sentence. jstack opened with my life story. Agents looking for "parallel agents" or "worktree" skills had no way to find it, and the ones that did had to copy files by hand.

## 2026-10-22: the /optimize skill and HOW-I-WORK.md

**What:** published `skills/optimize/`, my speed agent. It measures the built app and staging (load time, LCP, INP, TTFB, long tasks, the API waterfall, bundle size), ranks what costs the user the most time, fixes the top items and proves each fix with interleaved A/B runs and real statistics. Same placeholder treatment as the train, with its own section in ADAPT.md, including what the perf scripts need to do if your repo doesn't have them yet. Also added `HOW-I-WORK.md`: the workflow before the train (grilled plans, two-arm research, prototypes, A/B everything, debugging from traces, /simplify), with real examples.

**Why:** people asked what happens before a branch is "ready". And /optimize is the skill I'd miss most after /train. Identical code once showed a fake 140 ms "win" between two runs on my laptop, so it insists on numbers and interleaved runs.

## 2026-10-22: works on your machine now, not just mine

**What:** every machine-specific value is gone from the scripts and the skill. The scripts read env vars with defaults from `tools/jstack-env.sh`, and you set yours once in `~/.jstack/config.sh` (template in `tools/config.example.sh`). The skill files use `{{PLACEHOLDERS}}` instead of my paths, branch and commands, and the rules that only made sense in my own repo became generic ones. New `ADAPT.md` walks a coding agent (or you) through detecting the stack, filling every value, installing, wiring the briefs and checking it all works. The free RAM check now works on Linux and macOS too. `train.sh` waits for the PR checks and only merges when none failed, and it typechecks and pushes inside the heavy slot like the Lessons say. The repo moved to github.com/jayjayholic/jstack, so the links point there.

**Why:** the old way was "find my paths and change them", spread over five files, and the skill still talked about my repo's folders. Nobody should have to read my scripts line by line to try this. Also the Lessons said "merge only on zero failed checks" while the script didn't check. That's embarrassing, so now it does.

## 2026-10-21: worktree script and the memory bouncer

**What:** added `tools/new-worktree.sh` (one worktree per agent, copies the local env files git doesn't carry) and `tools/node-memory-watch.ps1` (when RAM hits 98%, it kills the fattest node or bun process over 5 GB).

**Why:** the train only works if every agent has its own worktree, and people asked how mine get created. The watcher is there because before the one-slot rule my laptop froze hard enough to wipe `.git/config`. It's the seatbelt, the lock is the brakes.

## 2026-10-21: README, clearer quickstart and structure

**What:** the README now starts with a short version of the idea, has a diagram of how a train moves, a quickstart (clone, install the skill, copy the tools, brief the agents, use the lock), a table of every path and setting you need to change for your machine, a note on when not to use a train, and a small FAQ. Same facts, same machine table, same file map and Lessons, written the way I'd explain it out loud.

**Why:** the first version explained the problem well but never said how to install anything, and "paths in the scripts are mine, change them" didn't say which ones. Anyone trying it had to read every script to find out.

## 2026-10-21: first public version, the /train skill

**What:** the `/train` skill (`skills/train/`), the shared heavy job lock (`tools/heavy-lock.sh`), the capped build runner and the train script.

**Why:** shipping around 40 parallel agent branches in a day through one PR per branch meant dozens of full builds and CI runs, constant conflicts, and a laptop that kept crashing. Trains check many branches with one build and one PR.

**Fixed along the way (all in SKILL.md, under Lessons):**
- One machine-wide heavy slot instead of separate locks for the train and the agents. Three parallel Turbopack builds crashed the PC twice.
- Typechecks and `git push` count as heavy too. A 4.9 GB `tsc` ran next to a build and free RAM hit 1.3 GB.
- `server_wait`: no `next start` while a build runs or below 8 GB free.
- Stale slot timeout went from 15 to 45 minutes, plus a race when the owner file vanished mid-check.
- Merge only with zero failed checks, poll deploys through the GitHub API instead of the Vercel CLI, check for late GitHub webhooks, never `git stash`, and recover a wiped `.git/config` after a crash.
