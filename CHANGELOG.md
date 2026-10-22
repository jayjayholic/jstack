# Changelog

Each entry says what changed and which problem it fixes.

## 2026-10-22: the planning skills ship with jstack

**What:** `/grill-me`, `/grilling` and `/wayfinder` are now in `skills/`, copied as-is from [mattpocock/skills](https://github.com/mattpocock/skills) (MIT, licence file in each folder), so `/plugin install` brings them too. `/simplify` gets `skills/simplify/README.md` instead of a copy: it's built into Claude Code and its licence doesn't allow redistributing it, and you already have it anyway. README, HOW-I-WORK.md and AGENTS.md now point at the in-repo copies.

**Why:** the README says plan first, but the planning skills lived in another repo, so people had to install things separately before jstack even made sense. Now it's one install. Heads up: `/wayfinder` also calls Matt's `research`, `prototype` and `domain-modeling` skills and expects an issue tracker set up with his `setup-matt-pocock-skills`; those still come from his repo.

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
