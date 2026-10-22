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

At most **two trains** exist at once: one in CI or merging, and ONE boarding. Every READY boards that one train until it leaves. The orchestrator keeps its queue in `{{QUEUE_FILE}}` (format in the `/train-queue` skill), so anyone can ask `/train-queue` where things are without poking the orchestrator.

Done when: the orchestrator is running and you hold its id.

## 3. Brief every worker agent the train way

Each worker gets its own worktree (`bash {{JSTACK_TOOLS}}/new-worktree.sh <branch> --install`). Paste the block in [worker-clause.md](worker-clause.md) into every coding agent's prompt, with the orchestrator id filled in. It carries the build rules (the most expensive mistake in this process) and the READY message format.

For an agent already running when the train starts, send it the same clause with SendMessage.

Done when: no worker prompt says "run the full build", "push" or "merge".

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

- **Free RAM.** Below 5% free, kill the heaviest process tree yourself (usually a build and its workers) and tell its agent. Never kill the agent CLI itself: it is often a node process too, and killing it kills every agent at once. On Windows `node-memory-watch.ps1` does the same thing as a seatbelt, with the CLI protected.
- **Build workers.** Count the build's worker processes. A build with a pile of workers is the RAM problem, not the number of agents.
- **Silent agents.** An agent running over 60 minutes without a report is a suspect: check what it is doing (its last notification, the slot owner, its worktree), then nudge it or stop it.
- **Orphans.** A server or browser whose agent has ended is an orphan; kill it. Otherwise its port stays busy and its RAM stays gone.
- **The slot.** `{{LOCK_DIR}}/owner` says who holds it and since when. Anything holding it that is not a build or a typecheck gets told to let go.

Done when: each round ends with RAM above 5% free, no orphans, and every silent agent checked.

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
- **No servers beside a build:** a worker's screenshot build reached 7.7 GB while another agent's server ran, and RAM fell to 1.8 GB free. While `{{LOCK_DIR}}` is held, nobody keeps a server running; start it after the slot is released.
- **Typechecks are heavy too:** the orchestrator ran a 4.9 GB `tsc` in one train worktree while another train built under the slot, and RAM fell to 1.3 GB free. A full typecheck takes the same slot as a build, never beside one.
- **A push is heavy too** when a pre-push hook typechecks, so `git push` took the slot like a build. Better fix: delete a pre-push hook that only repeats what CI already runs. Then a push is light again; `train.sh` only takes the slot for a push while a pre-push hook exists.
- **Stale-slot race (fixed 2026-10-21):** `heavy-lock.sh` treated a slot older than 15 min as abandoned and deleted it, but a train build can run longer, so a second build could start beside it. The stale check also crashed when another holder released the slot mid-check. Now: stale only after `JSTACK_STALE_MINUTES` (45 by default), and a missing owner file means "not stale". Keep the timeout above your longest build.
- **Servers wait for the slot:** before starting any server, run `server_wait {{MIN_FREE_GB}}` (from `heavy-lock.sh`): it waits until no build holds the slot and {{MIN_FREE_GB}} GB of RAM is free.
- **Build workers, not agents, ate the RAM (2026-10-22):** one `next build` spawned about 19 worker processes at 0.75 GB each (about 14 GB) and free RAM hit 2% with only that build in the slot. Next.js defaults its build workers to CPU count minus 1, and reads the count from `CIRCLE_NODE_TOTAL` when set, so `CIRCLE_NODE_TOTAL=5` gives 4 workers (check `cpus:` in `node_modules/next/dist/server/config-shared.js` for your version). Whatever your build tool is, cap its workers (`JSTACK_BUILD_ENV`) and check in its source that the cap really limits the count.
- **A hard RAM ceiling for builds (2026-10-22):** `NODE_OPTIONS` caps one heap, not a tree of workers, and Turbopack ignores it anyway. `heavy_capped "<cmd>"` runs the command with a ceiling on the WHOLE process tree (`JSTACK_CAP_GB`, default 12): a Windows Job Object through `run-capped.ps1`, or `systemd-run --user --scope -p MemoryMax` on Linux (untested). Past the ceiling the build dies with an out-of-memory error instead of freezing the machine. The ceiling counts committed memory, so it reads higher than Task Manager: the author's build OOMed at 6 and 8 GB and lives happily at 12.
- **Only builds and typechecks take the slot:** agents held it for screenshot runs and live proofs, which queued trains behind them for half an hour. Servers, screenshots and proofs use `server_wait` and never hold the slot.
- **Agents never build (2026-10-22):** workers ran about 15 production builds in one night just to screenshot their screens, starving the one slot while the train needed about one per batch. UI screenshots and visual checks run on a fast component gallery (`{{GALLERY_CMD}}`, no production build); live tests run on the integration deploy after the merge. The single exception is a pre-merge proof that must run the branch's own built code: one build, capped, inside the slot.
- **The full typecheck lives in the train:** workers prove their work with their tests and a check of what they touched; the one full typecheck runs once per train, inside the slot.
- **Build only when the deploy fails (2026-10-22):** no local production build by default, trains included (`JSTACK_TRAIN_BUILD=deploy`). After each merge, the integration deploy is the build check. If it fails, reproduce it with ONE capped local build (`JSTACK_TRAIN_BUILD=local train.sh typebuild`), fix it, and ship the fix as the next train with that build green; other trains wait until the integration branch builds again. Only for repos whose integration branch really deploys with a build; without one, keep `local`.
- **Max 2 trains:** stacking four trains behind each other tripled the CI runs and the wait. One in CI or merging, ONE boarding, and every READY boards that one.
- **The agent cap is about heavy jobs, not agents:** after a 2% RAM scare the author cut agents from 13 to 6. Wrong lever: the build was the problem. Cap the build, keep the agents.
- **Codegen once per schema, not once per worktree:** every new worktree regenerated the same ORM client from the same schema. `new-worktree.sh --install` now copies the generated folders (`JSTACK_CODEGEN_REUSE_PATHS`) from a sibling whose codegen inputs (`JSTACK_CODEGEN_INPUTS`, git tree hashes) match exactly, and runs codegen only when none does.
- **UI branches board with proof:** a user-facing branch joins a train only with its screenshots, a layout and contrast (WCAG AA) check at zero findings, and the current UI unchanged with its feature flag off. "It's behind a flag" is not a reason to ship code nobody looked at.
