---
name: train
description: "Use when the owner types /train, or when two or more branches from parallel AI coding agents (each in its own git worktree) must reach {{INTEGRATION_BRANCH}}: batch them into a merge train instead of one PR per branch. One orchestrator merges every ready branch onto a fresh {{INTEGRATION_BRANCH}}, runs one typecheck and one build, opens one PR, merges only on green checks and waits for the deploy. Also for builds or typechecks that run out of RAM or crash the machine when several agents build at once (machine-wide heavy-job lock, server_wait). Says when NOT to use a train (a single branch ships as its own PR)."
argument-hint: "[optional: branches/worktrees already ready]"
---

# /train: ship parallel work to {{INTEGRATION_BRANCH}}

"The owner" below is the human running the agents.

A **train** carries every ready branch to `{{INTEGRATION_BRANCH}}` in one go: merged together on a fresh `origin/{{INTEGRATION_BRANCH}}`, checked by **one** typecheck and **one** build, shipped as **one** PR. A laptop fits maybe two big builds in RAM; one build can check any number of branches. That is the point.

Settings (paths, commands, branch) live in the jstack config the scripts read (`~/.jstack/config.sh`, see `ADAPT.md`). The scripts are in `{{JSTACK_TOOLS}}`. If this file still has unfilled placeholders (names in double curly braces, for example when installed as a plugin), read `~/.jstack/config.sh` and use the matching `JSTACK_*` value; without a config, the tools folder is `${CLAUDE_PLUGIN_ROOT}/tools` and the rest come from the table in ADAPT.md, asking the owner for anything unknown.

## 1. Train or single PR

- **One branch, nothing else in flight**: no train. Its agent (or you) runs its tests and one typecheck inside the heavy slot, pushes, opens the PR to `{{INTEGRATION_BRANCH}}` with `{{PR_TEMPLATE}}`, waits for CI, merges, confirms the deploy is Ready. If the integration branch deploys with a real build, that deploy is the build check; if nothing deploys, run one capped build (`heavy_capped`) before the push. The push needs the owner's yes unless the owner already authorised that ship in this conversation.
- **Two or more branches in flight, or more agents still working**: train. Go to step 2.

Done when: you have said which path in one line.

## 2. Start the orchestrator (once per session)

Launch ONE background agent with the brief in [orchestrator-brief.md](orchestrator-brief.md), on a strong model. Keep its agent id: every other agent needs it, because subagents cannot list agents and cannot find the orchestrator by name.

The orchestrator ends when its queue empties. When a new branch is ready and the orchestrator has ended, launch a fresh one; never let worker agents push "just this once" instead.

At most **two trains** exist at once: one in CI or merging, and ONE boarding. Every READY boards that one train until it leaves. The two are pipelined: the boarding train is merged and typechecked while the other is in CI, and it leaves the moment that one merges. Boarding is continuous: each READY merges in and gets an incremental typecheck right away (`train.sh board <wt>@<sha>`). The orchestrator keeps its queue in `{{QUEUE_FILE}}` (format in the `/train-queue` skill), so anyone can ask `/train-queue` where things are without poking the orchestrator.

Done when: the orchestrator is running and you hold its id.

## 3. Brief every worker agent the train way

Each worker gets its own worktree (`bash {{JSTACK_TOOLS}}/new-worktree.sh <branch> --install`). Paste the block in [worker-clause.md](worker-clause.md) into every coding agent's prompt, with the orchestrator id filled in. It carries the build rules (the most expensive mistake in this process) and the READY message format.

For an agent already running when the train starts, send it the same clause with SendMessage.

**One agent per dependency chain, not per ticket.** When tickets depend on each other (B needs A's code), give the whole chain to one agent: it builds them in order on one stacked branch and sends READY after each ticket. Independent chains run in parallel. One agent per ticket means agents waiting for each other's merges, or guessing at code that doesn't exist yet.

**Gates first.** Write down what "done" means for a ticket (tests, screenshots, audits, numbers) before any agent starts. A gate added halfway forces rework on everything already READY.

Done when: no worker prompt says "run the full build", "push" or "merge", and every ticket has its gates written down.

## 4. Gate by the owner's approval

- **User-facing design** (new screens, cards, copy): the worker stops after screenshots; you show them to the owner; only after the owner's OK do you tell the orchestrator `GO <name>` and the worker sends READY.
- **Back-end fixes, tests, docs** the owner asked for: READY goes straight to the orchestrator.
- **Production, infrastructure, DNS, cloud env vars, anything outside the repo**: never inside a train. It is the owner's call, asked separately.

Done when: every READY branch is either approved or not user-facing.

### Agent cap and backlog

At most **{{AGENT_CAP}} agents** run at once, orchestrator included. Pick the cap by what agents hold, not by fear: agents that edit, test and typecheck in their own worktree are cheap; the heavy jobs (builds, full typechecks) are what crash machines, and those already wait for the one slot. When RAM runs out, fix the heavy job, keep the agents. New work beyond that goes to the backlog file `{{BACKLOG_FILE}}` (`ready` / `running` / `waits for the owner`); whenever a slot frees, the main session launches the top `ready` item with the worker clause and moves it to `running`.

### Owner away (overnight)

When the owner says they are going away and pre-approves some UI work: tell the orchestrator which user-facing branches are GO on READY, tell each UI worker to send READY after its screenshots, and ship to `{{INTEGRATION_BRANCH}}` only. Answer open questions from what the owner already decided in this session or wrote down; what that doesn't settle waits for the morning. Run a periodic watch (for example `/loop 15m`): are agents and the orchestrator alive, anything stuck, questions to settle. Leave a morning summary: what is live, screenshots to validate, what waits for the owner.

## 5. Relay, don't narrate

- Tell the owner when a train's **deploy is Ready** (not when the PR merges), in one line: PR number and what is now live. Check it with `{{DEPLOY_CHECK}}`.
- Post-deploy steps (backfills, data fixes, env changes) run only after Ready: dry run first, then the real run with the owner's yes, then the result in numbers.
- An agent's notification that only says "waiting" gets a one-line ack or none.

Done when: every merged train has been reported as live, and its post-deploy steps are run or explicitly pending.

## 6. The watch

While agents run, the main session keeps a periodic watch (for example `/loop 15m`). Each round:

- **Memory map.** Run `mem_map` (the `machine-memory` skill) every round and before every build, and keep one sampler running for the whole train (`mem_map -Watch -Every 30`). At 80% used or more, find the agent and the pattern behind it and tell the human, before it gets to 5%.
- **Free RAM.** Below 5% free, kill the heaviest process tree yourself (usually a build and its workers) and tell its agent. Never kill the agent CLI itself: it is often a node process too, and killing it kills every agent at once. On Windows `node-memory-watch.ps1` does the same thing as a seatbelt, with the CLI protected.
- **Build workers.** Count the build's worker processes. A build with a pile of workers is the RAM problem, not the number of agents.
- **Silent agents.** An agent running over 60 minutes without a report is a suspect: check what it is doing (its last notification, the slot owner, its worktree), then nudge it or stop it.
- **Orphans.** A server, browser or script whose agent has ended is an orphan; kill it. Otherwise its port stays busy and its RAM stays gone. Agents that end don't clean up after themselves as often as you'd hope.
- **Count only `running` agents.** Waiting or idle agents are parked and hold almost nothing; counting them against the cap starves the queue for no reason.
- **The slot.** `{{LOCK_DIR}}/owner` says who holds it and since when. Anything holding it that is not a build or a typecheck gets told to let go.

- **Freeze the rules while you measure.** Change one rule, then hold still long enough to see whether it helped (section 7). Five rule changes in one night means nobody can say which one worked.
- **Commit as you go.** Crashes and rate limits hit everyone at once; whatever wasn't committed is gone.

Done when: each round ends with RAM above 5% free, no orphans, and every silent agent checked.

## 6b. Worktree hygiene and the leftovers sweep

The train owns worktree hygiene.

- **One sweep owner at a time.** Exactly one agent (or script) removes worktrees at any moment, and it holds a lock file while it does (`clean-worktrees.sh` takes `${JSTACK_LOCK_DIR}-sweep`; a hand-run sweep takes the same lock). A second sweep that finds the lock held waits or stops; it never runs beside the first.
- **Never remove a worktree** that has untracked files outside build and scratch output (`artifacts/`, `.next/`, `node_modules/`, `.generated/`, logs), or that had any file modified in the last 2 hours. List it with the reason instead. Somebody is probably still working there.
- **Remove in small batches** (about 20 at a time) and check memory between batches: deleting worktrees refills the system file cache (the `machine-memory` skill, step 3b). If `git worktree remove` fails with "Filename too long", see that same step.

- **Right after a train merges:** remove every boarded branch's worktree that is clean and merged into {{INTEGRATION_BRANCH}} (`{{JSTACK_TOOLS}}/clean-worktrees.sh --dry-run` first). The branches stay as backup.
- **After each release, dispatch a leftovers sweep:** one agent per area, or per few worktrees, each told which worktrees and agents belonged to that train. A sweep agent removes only what is provably done and lists the rest for the human:
  1. **Worktrees** still present: remove each one that is clean, merged, untouched for 2 hours, and has no process under it (`mem_map`) and no slot owner `@` its path. List the rest with the reason.
  2. **Processes:** servers, loops, `tail -f` and grep started by the train's agents. Run `mem_map -Kill orphans`, then terminate whatever still runs under a removed worktree.
  3. **Uncommitted work:** list it with the files. Never discard it.
  4. **Dangling READYs:** branches that said READY but never boarded or bounced (queue file, orchestrator log). List them.
  5. **Stopped containers** (`docker ps -a --filter status=exited`): list them. Test databases stay.
  6. **Temp builds and proof folders** (before/after builds, build logs, scratch `.next` copies): remove what this train made and nothing uses; list the rest.
  7. **Slots** still held (`{{LOCK_DIR}}`, its `-tc-N` lanes): clear one only when its owner's directory has no live process.

Done when: the sweep report says, for each item, removed (what) or listed (why).

## 6c. The READY gate and the guard hooks

- **The READY gate.** Before a branch boards, the orchestrator runs `bash {{JSTACK_TOOLS}}/ready-gate.sh <worktree> --base origin/{{INTEGRATION_BRANCH}}`. It checks: the tree is committed, a green typecheck on that exact commit (through `tc_run`, cached per SHA), the unit tests next to the touched files, prettier on the touched files, and the brief checklist in `<worktree>/.agent/brief.md` fully ticked. Exit 0 boards. Exit 1 means don't board: send the FAIL lines back to the worker. Workers run the same gate before READY, so the orchestrator's typecheck comes back from the cache in a second. A READY whose gate is red doesn't board, however sure the worker sounds.
- **The brief checklist is a rule, not a hook.** The worker's first step is to copy the brief's items into `.agent/brief.md` as `- [ ]` lines (the file is ignored by git), and to tick each one with its evidence as it goes. An item not done is an unticked line, and the gate refuses it. A hook can't tell whether an item is really done, so the gate checks the file and the orchestrator checks the evidence.
- **Guard hooks** (only where the jstack plugin is installed and `~/.jstack/guards.json` names the project): bare `tsc`, `next build`, `typecheck`, `build` and installs are denied unless they run through the lock, recursive grep/find/du over the repo root, the worktrees folder or `node_modules` is denied, and when a subagent stops, the servers, loops and `tail -f` it left in its worktree get killed. Each denial tells the agent the exact retry.
- **Daily: read the hook report.** Once a day the orchestrator runs `node {{JSTACK_TOOLS}}/hook-report.mjs --days 1` (`jstack hook-report`). It shows blocks per day, agents blocked twice or more, and the calls that ignored the advice. An agent blocked over and over is struggling: nudge it or read its brief again. Tell the owner in one line whether the guards are costing agent quality (repeats and ignored advice going up) or not.

Done when: no branch boarded without a green gate, and today's hook report was read and summed up for the owner.

## 7. Measure it

Two formulas tell you where the time goes. Track the inputs hourly (from `gh pr list`, the queue file and the agent list), not from memory.

- **Little's law: L = λ·W.** L = tickets in flight (agents working plus READY not merged), λ = tickets MERGED per hour (not READY per hour), W = time from start to merged. It holds for long-run averages of a steady system. If L is far above λ·W, you are starting work faster than you finish it: queues grow and every new start makes the others wait. Example from the author's night: λ = 2/h and W = 1.75 h predict L = 3.5, but L was about 20, so new work was really waiting about 10 h. Starting less was the fastest way to finish more.
- **Clean batch: P(clean) = (1 - p)^n.** p = chance one branch breaks the train's typecheck, n = branches per train. At p = 0.27 (measured, 3 of 11), a train of 8 is clean 8% of the time and a train of 11 3%; at p = 0.05 a train of 8 is clean 66% of the time. So push p down at the source (the typecheck lane before READY), and when a train fails, drop the branch the errors name instead of fixing it in place: with free attribution (a typecheck names the file), dropping cost about 130 waiting branch-minutes per failed train against about 430 for fixing in place. Bisection only pays when a failure can't be attributed (flaky or unnamed tests).
- **Utilization.** If CI is busy a third of the night, CI is not your bottleneck. Look upstream: work in progress, p, the machine, and rule churn.

Done when: you can say λ, W, L and p for the last few hours, and which rule change moved which of them.

Tools behind the orchestrator: `{{JSTACK_TOOLS}}/train.sh` (`build <wt...>`, `shiptrain`), `{{JSTACK_TOOLS}}/coordinator-build.sh` (waits for {{MIN_FREE_GB}} GB free, one build at a time).

## Lessons

These come from the author's setup (Bun, Next.js with Turbopack, Windows, 32 GB, 2026-10-20 to 22). The numbers are his; the rules carry over.

- **Builds:** agents told to "run the full build" each started their own (4.8 and 5.5 GB, uncapped) beside the train's. Only the train verifies with a build (see "Agents never build" below). Dev servers with hot reload are the hungriest of all (3 to 6 GB for Next.js); avoid them unless hot reload is the thing being tested.
- **The slot wraps only heavy jobs.** Servers, A/B runs, tests and installs stay outside it; a slot held for A/B runs once queued 14 agents for 3 hours.
- **Orchestrator death:** an API rate limit killed the orchestrator mid-build and left its train worktree half-built. A resumed orchestrator re-fetches `{{INTEGRATION_BRANCH}}` and rebuilds from scratch.
- **Killing node:** killing every node process to free RAM kills the train build, every agent's servers and tests, and node-based MCP servers. Message the orchestrator and each agent to restart only what they need. Docker containers survive.
- **Silent workers:** a worker that reports "I couldn't reach the orchestrator" means its prompt lacked the id; forward its READY yourself and fix the prompt.
- **Pre-existing red:** a CI job that fails the same way on `{{INTEGRATION_BRANCH}}` does not block a train; the orchestrator says so in the PR and someone fixes it.
- **Conflicts:** append-only files (`{{UNION_FILES}}`) keep both sides (`git merge-file --union`); any other conflict is resolved file by file, never with `-X ours` or `-X theirs`.
- **Stacked branches:** a branch based on another unmerged branch rides in the same train or the one after its base, and is rebased once the base merges.
- **Env after deploy:** on hosts like Vercel an env var change needs a redeploy to take effect.
- **Rate limit hits everyone at once:** one night every agent and the orchestrator stopped on the same session limit. After the reset, resume each with SendMessage (work is saved); the orchestrator re-fetches and rebuilds what was interrupted.
- **Shared stash:** worktrees share one stash stack; a bare `git stash pop` in one worktree landed another agent's changes in it. Workers use WIP commits, never bare stash/pop.
- **PC crash:** a hard crash zeroed `.git/config` after `[core]` (git refused every command). Fix: keep `[core]`, re-add `[remote "origin"]` (URL from `.git/FETCH_HEAD`), restore tracking for every local branch that exists on origin, `git fsck`. Then resume every agent with "check your worktree first" (status, fsck, stale build output).
- **One build slot for the machine:** the train had its own lock and agents had two more, so three Turbopack builds (about 5 GB each; `NODE_OPTIONS` doesn't cap Turbopack) plus typechecks crashed the PC twice. Now the train and every agent share ONE slot (`{{LOCK_DIR}}`).
- **Merge only on zero failed checks:** a merge command that didn't stop on red merged a PR with a unit test job failing (an infra flake: a dependency download reset mid-install). Gate the merge on `gh pr checks` reporting no failure; re-run a flaky job and confirm green before merging, never after. `train.sh` does this.
- **Never poll the deploy host with its CLI in a loop:** an orchestrator watched a delayed deploy with `vercel ls` in a loop; the process grew to 4 GB next to a train build. Poll with `gh api repos/<owner>/<repo>/deployments?ref={{INTEGRATION_BRANCH}}` or a `curl -sI` of the deployed URL, every ~10 min, never as a long-lived child.
- **Delayed webhooks:** during a GitHub webhook incident, merges started no Actions and no deploy for hours. Check githubstatus.com first, run any deploy workflow by hand if needed, and wait for the delayed delivery before calling a train live.
- **The host's statuses vanish, the deploy may still run (2026-10-22):** while GitHub was degraded (check githubstatus.com), the host's commit statuses (Vercel's, say) went missing from the merge commit, but the deploys behind them still ran. Missing statuses are not a missing deploy. Check ONE time with the host's CLI (`vercel ls`) for a deploy created after your merge, then stop. One look, not a loop: the last CLI poll loop grew to 4 GB, and the 32 GB laptop noticed.
- **The webhook never fires: deploy by hand from a clean export (2026-10-22):** if no deploy shows up about 10 min after a merge, deploy the target branch yourself, from a clean export, never from your dirty working tree (half-finished edits and stray env files would ship with it):
  - `git archive origin/<branch> | tar -x -C <scratch>`
  - `vercel link --yes` inside `<scratch>`
  - delete the `.env.local` that `link` pulls down; never upload it, never keep it
  - `vercel deploy --target <env>`; the env's domain gets aliased to the new deploy
  - delete `<scratch>` afterwards
- **Editing a file through the GitHub contents API from Git Bash on Windows truncates it (2026-10-22):** `jq -r .content | base64 -d` choked on the `\r\n` in the API's base64, and the commit went through with a silently truncated file. No error, just a shorter file. Build the new content from `git show origin/<branch>:<path>`, base64 it from a file (not a pipe of the API's string), and always diff the branch against its base before merging.
- **When GitHub Actions won't start jobs (2026-10-22):** credits ran out (or billing failed, or the spending limit was hit), and every check failed in about 2 s with "recent account payments have failed or your spending limit needs to be increased". That red is not a test result, so never merge on it, and never merge on a real red either. With the owner's OK, the train runs CI's own checks locally instead: the merge-strategy guard on the PR range, Prettier on the changed files, `{{TYPECHECK_CMD}}`, and the unit suites under `heavy_capped`. All green: merge with `gh pr merge --admin` and paste the local results into the PR body. The deploy still comes from the host's own GitHub app, so confirm Ready from the commit statuses. Jobs that only run in Actions (a deploy workflow, say) wait until billing is back. Don't build a self-hosted CI runner just for this; the plain commands are enough, and the 32 GB laptop already has a day job. Side finding: self-hosted runners that already exist keep running jobs while billing is blocked.
- **No servers beside a build:** a worker's screenshot build reached 7.7 GB while another agent's server ran, and RAM fell to 1.8 GB free. While `{{LOCK_DIR}}` is held, nobody keeps a server running; start it after the slot is released.
- **Typechecks are heavy too:** the orchestrator ran a 4.9 GB `tsc` in one train worktree while another train built under the slot, and RAM fell to 1.3 GB free. A full typecheck takes the same slot as a build, never beside one.
- **A push is heavy too** when a pre-push hook typechecks, so `git push` took the slot like a build. Better fix: delete a pre-push hook that only repeats what CI already runs. Then a push is light again; `train.sh` only takes the slot for a push while a pre-push hook exists.
- **Stale-slot race (fixed 2026-10-21):** `heavy-lock.sh` treated a slot older than 15 min as abandoned and deleted it, but a train build can run longer, so a second build could start beside it. The stale check also crashed when another holder released the slot mid-check. Now: stale only after `JSTACK_STALE_MINUTES` (45 by default), and a missing owner file means "not stale". Keep the timeout above your longest build.
- **Servers wait for the slot:** before starting any server, run `server_wait {{MIN_FREE_GB}}` (from `heavy-lock.sh`): it waits until no build holds the slot and {{MIN_FREE_GB}} GB of RAM is free.
- **Build workers, not agents, ate the RAM (2026-10-22):** one `next build` spawned about 19 worker processes at 0.75 GB each (about 14 GB) and free RAM hit 2% with only that build in the slot. Next.js defaults its build workers to CPU count minus 1, and reads the count from `CIRCLE_NODE_TOTAL` when set, so `CIRCLE_NODE_TOTAL=5` gives 4 workers (check `cpus:` in `node_modules/next/dist/server/config-shared.js` for your version). Whatever your build tool is, cap its workers (`JSTACK_BUILD_ENV`) and check in its source that the cap really limits the count.
- **A hard RAM ceiling for builds (2026-10-22):** `NODE_OPTIONS` caps one heap, not a tree of workers, and Turbopack ignores it anyway. `heavy_capped "<cmd>"` runs the command with a ceiling on the WHOLE process tree (`JSTACK_CAP_GB`, default 12): a Windows Job Object through `run-capped.ps1`, or `systemd-run --user --scope -p MemoryMax` on Linux (untested). Past the ceiling the build dies with an out-of-memory error instead of freezing the machine. The ceiling counts committed memory, so it reads higher than Task Manager: the author's build OOMed at 6 and 8 GB and lives happily at 12.
- **Only builds and typechecks take the slot:** agents held it for screenshot runs and live proofs, which queued trains behind them for half an hour. Servers, screenshots and proofs use `server_wait` and never hold the slot.
- **Agents never build (2026-10-22):** workers ran about 15 production builds in one night just to screenshot their screens, starving the one slot while the train needed about one per batch. A fast component gallery (a Vite page rendering the components) starts in 39 s under 1 GB; the production build it replaced took 1.5 to 8 min and 6.5 to 9 GB. UI screenshots and visual checks run on a fast component gallery (`{{GALLERY_CMD}}`, no production build); live tests run on the integration deploy after the merge. The single exception is a pre-merge proof that must run the branch's own built code: one build, capped, inside the slot.
- **Shift the typecheck left (replaces "the full typecheck lives in the train"):** skipping the worker typecheck pushed failures downstream into one serial orchestrator, and 27% of branches broke the train's typecheck. Now every worker runs ONE typecheck in the typecheck lane before READY (`tc_run`, at most 2 parallel: a native `tsc` peaks around 5 GB, and 4 parallel lanes took the 32 GB laptop to 0.3 GB free). READY must say `typecheck green at <sha>`, and a head that moved past that sha doesn't board.
- **The train is a quick merge:** merge the ready branches, one incremental integration typecheck (about a minute) for cross-branch errors only, push, PR. A failing branch is dropped and bounced with its error lines, never fixed in the train and never waited on; its fix boards the next train. For big trains, run CI's own suites locally before pushing.
- **Build only when the deploy fails (2026-10-22):** no local production build by default, trains included (`JSTACK_TRAIN_BUILD=deploy`). After each merge, the integration deploy is the build check. If it fails, reproduce it with ONE capped local build (`JSTACK_TRAIN_BUILD=local train.sh typebuild`), fix it, and ship the fix as the next train with that build green; other trains wait until the integration branch builds again. Only for repos whose integration branch really deploys with a build; without one, keep `local`.
- **Max 2 trains:** stacking four trains behind each other tripled the CI runs and the wait. One in CI or merging, ONE boarding, and every READY boards that one.
- **The agent cap is about heavy jobs, not agents:** after a 2% RAM scare the author cut agents from 13 to 6. Wrong lever: the build was the problem. Cap the build, keep the agents.
- **Codegen once per schema, not once per worktree:** every new worktree regenerated the same ORM client from the same schema. `new-worktree.sh --install` now copies the generated folders (`JSTACK_CODEGEN_REUSE_PATHS`) from a sibling whose codegen inputs (`JSTACK_CODEGEN_INPUTS`, git tree hashes) match exactly, and runs codegen only when none does.
- **UI branches board with proof:** a user-facing branch joins a train only with its screenshots, a layout and contrast (WCAG AA) check at zero findings, and the current UI unchanged with its feature flag off. "It's behind a flag" is not a reason to ship code nobody looked at.
- **Deploy-only failures:** a local build can't see what the upload leaves out. Ignore files for the deploy upload (`.vercelignore` and friends) use gitignore rules, so an unanchored `docs/` stripped every `docs` folder in the tree, including `src/**/docs`, and the integration deploy failed while every local check was green. Anchor ignore paths to the root (`/docs/`). The deploy is the check for this whole class.
- **Reused generated code must be complete:** a copy taken from a sibling mid-codegen had the right schema hash and half the output, and a train typecheck failed with 80 errors from a missing typed-SQL client. Reuse needs the inputs hash to match AND every generated client to exist and be non-empty (`JSTACK_CODEGEN_REQUIRED`), checked again after the copy. With that, codegen per worktree went from 519 s to about zero.
- **The pre-push hook that repeated CI:** it ran a full typecheck on every push, 10 to 15 min each, inside the slot. CI runs the same check. Deleted.
- **One agent per chain (2026-10-22):** with one agent per ticket, merged throughput was about 3 tickets/h. Giving each dependency chain to one agent (stacked branch, READY per ticket) took it to about 27 tickets/h the same night. Honest footnote: part of that jump is parallel work that had piled up landing together, so the steady number is lower. Still the biggest single change of the night.
- **"Done" without proof (2026-10-25):** 28 "ready" claims in two days came without proof: the typecheck was never run on the final commit, or brief items had quietly disappeared. Each one bounced the train or sent the owner back to repeat himself. Now READY goes through `ready-gate.sh` (section 6c), and the brief is a checklist the gate reads.
- **Rules agents skipped became hooks (2026-10-25):** "typecheck only through `tc_run`" sat in every brief and still got skipped 21 times. Bare typechecks at 5 to 8 GB each, `grep -r` over 185 worktrees, and servers left behind by finished agents kept the laptop at 0.2 to 3% free RAM. The jstack guard hooks deny the first two and clean up the third, and the hook report shows whether the denials cost agents anything.
- **Late gates:** a UI gate (layout and contrast audit) added after branches were READY sent them all back for rework. Gates go in the plan, before the first agent starts.
- **Format, don't just check:** the ship step runs the formatter in write mode on the changed files and commits the result. A check that only warned let a train PR fail lint on one file.
- **Never commit in a worker's live worktree:** an agent stacking its next ticket keeps uncommitted edits there, and `git add <dir>` sweeps them into your fix. Commit train fixes in the train worktree and tell the agent.
- **Never let a conflict resolution past a failed check:** chain `<format check> <files> && git commit`, never `;`. A union of two conflict blocks cut an interface in half (its closing brace was shared context), and only the parser noticed.
- **Publish the boarding train as `train/<date>-<n>-wip`** when you bounce branches for conflicts, so their agents merge the exact base instead of guessing.
- **Rule churn:** rules changed five times in one night, each after the last incident, so no change could be measured. Hold a rule still long enough to compare (section 7).
- **Open every failure line before calling it a flake (2026-10-22):** a train merged on a real red because 3 of its 6 failures got waved off as "worktree state". One of them was a genuine regression in a test mock. Read each failing line yourself; "probably the environment" is a guess, not a result. Not sure? Run the same suite on the previous merges and bisect until the first red shows up.
- **The host build runs out of memory after an account or billing switch (2026-10-22):** the deploy died with "Killed / exit 137 / Out of Memory" while every local build passed. Measure first: ONE capped local build (`heavy_capped`) with peak memory logged. The author's peaked around 9.8 GB, above a standard 8 GB builder (and a fair chunk of the 32 GB laptop, which took it personally). The cause was the host's build machine size, which had silently dropped back to standard after the switch. Check it through the host's API, not the dashboard (on Vercel: `GET /v9/projects/<name>` and read `resourceConfig.buildMachineType`). You can set it back with a PATCH using the host CLI's own token, but it changes the bill, so only with the owner's explicit go.
- **Host blocked? One big train, not many small ones (2026-10-22):** while the host was down, dozens of ready branches piled up, and lining them up as many small trains would have meant many waits, many CI runs and many deploys. Once the host is back, board them ALL into ONE train, drop the ones that conflict (bounce them for the next train), and ship the rest.
- **Workers never start their own app servers (2026-10-22):** several workers each started a 2 to 5 GB app server for "a quick look", plus their typechecks, and free RAM hit 2%. On a laptop (yes, even the 32 GB one) workers use the component gallery (`{{GALLERY_CMD}}`) and test scripts. If something truly needs the running app, there is ONE shared server, started once and reused.
- **Two sweeps at once ate kept worktrees (2026-10-25):** two cleanup sweeps ran at the same time. One of them had decided to keep some worktrees (recently changed, or holding untracked files), and the other removed them anyway. Now there is exactly one sweep owner at a time, enforced by a lock file, and no sweep removes a worktree with untracked work or one modified in the last 2 hours (section 6b).
- **Deleting worktrees eats RAM too (2026-10-25):** removing a few hundred worktrees in one go filled the system file cache to 16.8 GB, and it stayed resident instead of trimming. Batches of about 20, then the `machine-memory` skill's step 3b if the cache won't let go. The 32 GB laptop would like a word about the other 348.
