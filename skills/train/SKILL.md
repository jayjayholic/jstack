---
name: train
description: "Use when the owner types /train, or when two or more branches from parallel agents must reach stage. Runs the ship train: agents report READY, one orchestrator merges every ready branch onto fresh stage, one typecheck + one build, one PR, merge, deploy Ready. Also says when NOT to use a train (a single branch ships as its own PR)."
argument-hint: "[optional: branches/worktrees already ready]"
---

# /train: ship parallel work to stage

A **train** carries every ready branch to `stage` in one go: merged together on fresh `origin/stage`, checked by **one** typecheck and **one** `next build`, shipped as **one** PR. A machine fits about two Next builds in RAM; one build can check any number of branches. That is the whole point.

## 1. Train or single PR

- **One branch, nothing else in flight** → no train. Its agent (or you) runs typecheck + tests + one capped build, pushes, opens the PR to `stage` with the template, waits for CI, merges, confirms deploy Ready. The PUSH needs the owner's yes (CLAUDE.md GIT PUSH RULE) unless the owner already authorised that ship in this conversation.
- **Two or more branches in flight, or more agents still working** → train. Go to step 2.

Done when: you have said which path in one line.

## 2. Start the orchestrator (once per session)

Launch ONE background agent with the brief in [orchestrator-brief.md](orchestrator-brief.md) (`model: "opus"`, effort `medium`). Keep its agent id: every other agent needs it, because subagents cannot list agents and cannot find the orchestrator by name.

The orchestrator ends when its queue empties. When a new branch is ready and the orchestrator has ended, launch a fresh one; never let worker agents push "just this once" instead.

Done when: the orchestrator is running and you hold its id.

## 3. Brief every worker agent the train way

Paste the block in [worker-clause.md](worker-clause.md) into every coding agent's prompt, with the orchestrator id filled in. It carries the build rules (the most expensive mistake in this process) and the READY message format.

For an agent already running when the train starts, send it the same clause with SendMessage.

Done when: no worker prompt says "full next build", "push" or "merge".

## 4. Gate by the owner's approval

- **Member-facing design** (new screens, cards, copy): the worker stops after screenshots; you open the contact sheet on the owner's screen; only after the owner's OK do you tell the orchestrator `GO <name>` and the worker sends READY.
- **Back-end fixes, tests, docs** the owner asked for: READY goes straight to the orchestrator.
- **Anything touching graphiti/Neo4j on EC2, production, DNS, AWS or Vercel env**: never inside a train; it is the owner's call, asked separately.

Done when: every READY branch is either approved or not member-facing.

### Agent cap and backlog

At most **13 agents** run at once, orchestrator included. New work beyond that goes to the backlog `docs/jay-works/backlog.md` (`ready` / `running` / `waits for the owner`); whenever a slot frees, the main session launches the top `ready` item with the worker clause and moves it to `running`.

### Owner away (overnight)

When the owner says he is going away and pre-approves UI built with the house-ui skill: tell the orchestrator which member-facing branches are GO on READY, tell each UI worker to send READY after its contact sheet (1280x720 included), and keep stage only. Open questions are answered from the owner's Hakutaku brain (via the `hakutaku` subagent) and this session's context; what neither settles waits for the morning. Run a `/loop 15m` watch: are agents and the orchestrator alive, anything stuck, questions to settle; with nothing in flight, run a UI/UX sweep of stage (screenshots at 1280x720 and 375 of the main screens, bugs fixed through the train). Leave a morning summary: what is live, contact sheets to validate, what waits for him.

## 5. Relay, don't narrate

- Tell the owner when a train's **stage deploy is Ready** (not when the PR merges), in one line: PR number and what is now live.
- Post-deploy steps (backfills, data fixes, env changes) run only after Ready: dry run first, then `--apply` with the owner's yes, then the result in numbers.
- An agent's notification that only says "waiting" gets a one-line ack or none.

Done when: every merged train has been reported as live, and its post-deploy steps are run or explicitly pending.

## Lessons (2026-10-20/21)

- **Builds:** agents told to "run the full build" each started their own (4.8 and 5.5 GB, uncapped) beside the train's; the owner caught it. Only the orchestrator builds to verify. A worker builds only to `next start` for screenshots or a live test, with `NODE_OPTIONS=--max-old-space-size=4096`, under the shared lock (`source /c/dev/hakutaku/heavy-lock.sh; heavy_acquire <name>; <build>; heavy_release`), and stops the server right after. `next dev` never (3–6 GB).
- **The lock wraps only `next build`.** Servers, A/Bs, tests and installs outside it; a lock held for A/Bs queued 14 agents for 3 h once.
- **Orchestrator death:** an API rate limit killed the orchestrator mid-build; its train worktree was left half-built. A resumed orchestrator re-fetches stage and rebuilds from scratch.
- **Killing node:** killing every `node.exe` (owner's call, to free RAM) kills the train build, every agent's servers and tests, and node-based MCP servers; message the orchestrator and each agent to restart only what they need. Docker containers survive.
- **Silent workers:** a worker that reports "I couldn't reach the orchestrator" means its prompt lacked the id; forward its READY yourself and fix the prompt.
- **Pre-existing red:** a CI job failing identically on `stage` (the 3 `packages/ai` tests, fixed in #649) does not block a train; the orchestrator states it in the PR and someone fixes it.
- **Conflicts:** `docs/technical/harness/findings-log.md` is append-only, so both sides are kept (`git merge-file --union`); any other conflict is resolved file by file, never `-X ours/theirs`.
- **Stacked branches:** a branch based on another unmerged branch rides in the same train or the one after its base, and is rebased once the base merges.
- **Env after deploy:** a Vercel env change needs a redeploy (`vercel redeploy <url> --target staging`) to take effect.

Tools behind the orchestrator: `/c/dev/hakutaku/tools/train.sh` (`build <wt…>`, `shiptrain`), `/c/dev/hakutaku/tools/coordinator-build.sh` (waits for ≥ 8 GB free, one build).
- **Rate limit hits everyone at once:** at ~02:10 every agent and the orchestrator stopped on the same session limit. After the reset, resume each with SendMessage (work is saved); the orchestrator re-fetches stage and rebuilds what was interrupted.
- **Shared stash:** worktrees share one stash stack; a bare `git stash pop` in one worktree landed another agent's changes in it. Workers use WIP commits, never bare stash/pop.
- **PC crash:** a hard crash zeroed `.git/config` after `[core]` (git refused every command). Fix: keep `[core]`, re-add `[remote "origin"]` (URL from `.git/FETCH_HEAD`), restore tracking for every local branch that exists on origin, `git fsck`. Then resume every agent with "check your worktree first" (status, fsck, stale `.next`/`.generated`).
- **One build slot for the machine:** the train had its own lock and agents had two more, so three Turbopack builds (~5 GB each; NODE_OPTIONS doesn't cap Turbopack) plus typechecks crashed the PC twice. Now the train and every agent share ONE slot (`/c/dev/hakutaku/.heavy-lock`), and at most ~6 agents work at once; the rest wait in the backlog.
- **Merge only on zero failed checks:** a merge command that doesn't stop on red merged #665 with "Unit Tests (packages/ai)" failing (an infra flake: Prisma engine download ECONNRESET in bun install). Gate the merge on `gh pr checks` reporting no failure; re-run a flaky job and confirm green before merging, never after.
- **Never poll Vercel with the CLI:** an orchestrator watched a delayed stage deploy with `vercel ls` in a loop; the process grew to 4 GB, which took RAM to 2 GB free next to a train build. Poll with `gh api repos/<repo>/deployments?ref=stage` or a `curl -sI` of the stage URL, every ~10 min, never as a long-lived child.
- **Delayed webhooks:** during a GitHub webhook incident, merges to stage start no Actions and no Vercel deploy. Check githubstatus.com first, dispatch `deploy-graphiti.yml` by hand if graphiti changed, and wait for the delayed delivery before calling a train live.
- **No servers beside a build:** a worker's screenshot build reached 7.7 GB (Turbopack ignores `--max-old-space-size`) while another agent's `next start` ran, and RAM fell to 1.8 GB free. While `/c/dev/hakutaku/.heavy-lock` is held, nobody else keeps a `next start` running; start it after the lock is released.
- **Typechecks are heavy too:** the orchestrator ran a 4.9 GB `tsc` in one train worktree while another train built under the lock, and RAM fell to 1.3 GB free. A full typecheck takes the same slot as a build (`heavy_acquire` around `tsc`), never beside one.
- **A push is heavy too:** the repo's pre-push hook runs `typecheck:ci`, so `git push` takes the slot like a build; the phantom TS2589 there made several first pushes fail (a retry passes).
- **Stale-slot race (fixed 2026-10-21):** `heavy-lock.sh` treated a slot older than 15 min as abandoned and deleted it, but a train build can run longer, so a second build could start beside it (a likely cause of several RAM spikes). The stale check also crashed ("cannot stat … owner") when another holder released the slot mid-check. Now: stale only after 45 min, and a missing owner file means "not stale". If you change the timeout, keep it above the longest build.
- **Servers wait for the slot:** before any `next start`, run `server_wait 8` (from `heavy-lock.sh`): it waits until no build holds the slot and 8 GB of RAM is free.
