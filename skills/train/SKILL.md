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

- **One branch, nothing else in flight**: no train. Its agent (or you) runs typecheck + tests + one build under the heavy slot, pushes, opens the PR to `{{INTEGRATION_BRANCH}}` with `{{PR_TEMPLATE}}`, waits for CI, merges, confirms the deploy is Ready. The push needs the owner's yes unless the owner already authorised that ship in this conversation.
- **Two or more branches in flight, or more agents still working**: train. Go to step 2.

Done when: you have said which path in one line.

## 2. Start the orchestrator (once per session)

Launch ONE background agent with the brief in [orchestrator-brief.md](orchestrator-brief.md), on a strong model. Keep its agent id: every other agent needs it, because subagents cannot list agents and cannot find the orchestrator by name.

The orchestrator ends when its queue empties. When a new branch is ready and the orchestrator has ended, launch a fresh one; never let worker agents push "just this once" instead.

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

At most **{{AGENT_CAP}} agents** run at once, orchestrator included (on a 32 GB laptop about six of them can do real work at the same time). New work beyond that goes to the backlog file `{{BACKLOG_FILE}}` (`ready` / `running` / `waits for the owner`); whenever a slot frees, the main session launches the top `ready` item with the worker clause and moves it to `running`.

### Owner away (overnight)

When the owner says they are going away and pre-approves some UI work: tell the orchestrator which user-facing branches are GO on READY, tell each UI worker to send READY after its screenshots, and ship to `{{INTEGRATION_BRANCH}}` only. Answer open questions from what the owner already decided in this session or wrote down; what that doesn't settle waits for the morning. Run a periodic watch (for example `/loop 15m`): are agents and the orchestrator alive, anything stuck, questions to settle. Leave a morning summary: what is live, screenshots to validate, what waits for the owner.

## 5. Relay, don't narrate

- Tell the owner when a train's **deploy is Ready** (not when the PR merges), in one line: PR number and what is now live. Check it with `{{DEPLOY_CHECK}}`.
- Post-deploy steps (backfills, data fixes, env changes) run only after Ready: dry run first, then the real run with the owner's yes, then the result in numbers.
- An agent's notification that only says "waiting" gets a one-line ack or none.

Done when: every merged train has been reported as live, and its post-deploy steps are run or explicitly pending.

Tools behind the orchestrator: `{{JSTACK_TOOLS}}/train.sh` (`build <wt...>`, `shiptrain`), `{{JSTACK_TOOLS}}/coordinator-build.sh` (waits for {{MIN_FREE_GB}} GB free, one build at a time).

## Lessons

These come from the author's setup (Bun, Next.js with Turbopack, Windows, 32 GB, 2026-10-20/21). The numbers are his; the rules carry over.

- **Builds:** agents told to "run the full build" each started their own (4.8 and 5.5 GB, uncapped) beside the train's. Only the orchestrator builds to verify. A worker builds only when it needs a running server for screenshots or a live test, under the shared slot (`source {{JSTACK_TOOLS}}/heavy-lock.sh; heavy_acquire <name>; {{BUILD_CMD}}; heavy_release`), and stops the server right after. Dev servers with hot reload are the hungriest of all (3 to 6 GB for Next.js); avoid them unless hot reload is the thing being tested.
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
- **One build slot for the machine:** the train had its own lock and agents had two more, so three Turbopack builds (about 5 GB each; `NODE_OPTIONS` doesn't cap Turbopack) plus typechecks crashed the PC twice. Now the train and every agent share ONE slot (`{{LOCK_DIR}}`), and only about six agents work at once; the rest wait in the backlog.
- **Merge only on zero failed checks:** a merge command that didn't stop on red merged a PR with a unit test job failing (an infra flake: a dependency download reset mid-install). Gate the merge on `gh pr checks` reporting no failure; re-run a flaky job and confirm green before merging, never after. `train.sh` does this.
- **Never poll the deploy host with its CLI in a loop:** an orchestrator watched a delayed deploy with `vercel ls` in a loop; the process grew to 4 GB next to a train build. Poll with `gh api repos/<owner>/<repo>/deployments?ref={{INTEGRATION_BRANCH}}` or a `curl -sI` of the deployed URL, every ~10 min, never as a long-lived child.
- **Delayed webhooks:** during a GitHub webhook incident, merges started no Actions and no deploy for hours. Check githubstatus.com first, run any deploy workflow by hand if needed, and wait for the delayed delivery before calling a train live.
- **No servers beside a build:** a worker's screenshot build reached 7.7 GB while another agent's server ran, and RAM fell to 1.8 GB free. While `{{LOCK_DIR}}` is held, nobody keeps a server running; start it after the slot is released.
- **Typechecks are heavy too:** the orchestrator ran a 4.9 GB `tsc` in one train worktree while another train built under the slot, and RAM fell to 1.3 GB free. A full typecheck takes the same slot as a build, never beside one.
- **A push is heavy too** when the pre-push hook typechecks, so `git push` takes the slot like a build.
- **Stale-slot race (fixed 2026-10-21):** `heavy-lock.sh` treated a slot older than 15 min as abandoned and deleted it, but a train build can run longer, so a second build could start beside it. The stale check also crashed when another holder released the slot mid-check. Now: stale only after `JSTACK_STALE_MINUTES` (45 by default), and a missing owner file means "not stale". Keep the timeout above your longest build.
- **Servers wait for the slot:** before starting any server, run `server_wait {{MIN_FREE_GB}}` (from `heavy-lock.sh`): it waits until no build holds the slot and {{MIN_FREE_GB}} GB of RAM is free.
