---
name: train-queue
description: "Use when the owner types /train-queue or asks what the merge train merged, what ships next, or what each parallel agent is doing. Prints one read-only status board: trains merged and live on {{INTEGRATION_BRANCH}}, the train in flight, the queue (ready, held and why), and every running agent's current job, read from GitHub, the heavy slot, the orchestrator's queue file and the agent list."
---

# /train-queue: where the train is

A read-only status board for the `/train` system. It changes nothing: no builds, no pushes, no messages that start work.

If this file still has unfilled placeholders (names in double curly braces), read `~/.jstack/config.sh` and use the matching `JSTACK_*` value, or ask the owner.

## Sources

Read all of these in parallel; each one answers a different part of the board.

| Source | How | Answers |
|---|---|---|
| Merged trains | `gh pr list --base {{INTEGRATION_BRANCH}} --state merged --limit 8 --json number,title,mergedAt,mergeCommit` | what merged |
| Deploy | `{{DEPLOY_CHECK}}` for each merge commit (or `gh api repos/<owner>/<repo>/commits/<sha>/statuses`) | what is live |
| Open train PRs | `gh pr list --base {{INTEGRATION_BRANCH}} --state open --json number,title,headRefName` + `gh pr checks <n>` | the train in CI |
| Heavy slot | `cat {{LOCK_DIR}}/owner` (absent = free) | what is building or typechecking now |
| Queue file | `{{QUEUE_FILE}}`, kept by the orchestrator | boarding, ready, held + why, next steps |
| Agents | your harness's agent list (status), plus each running agent's launch description and last report in this conversation | what each agent is doing |
| Cloud sessions | the session registry (`~/.jstack/cloud-sessions.json` or your kit's) and each entry's last handoff state | which READY branches run their heavy checks in the cloud |
| Backlog | `{{BACKLOG_FILE}}` (`ready`, `running`, `waits for the owner`) | what waits |

Never read a subagent's full transcript file to learn its state (it overflows the context); use its last notification, or ask it with SendMessage only if the owner wants detail.

If the queue file is missing or older than 30 min, ask the orchestrator with SendMessage for its queue (boarding / ready / held with reason) and say the board used its reply.

## Output

One board, at most ~45 lines, built to be read at a glance: the owner should know in five seconds whether anything waits on him.

### Status dots

Every row starts with exactly one dot. The dot answers "does this need the owner, and is it moving?":

| Dot | Means | Examples |
|---|---|---|
| 🔴 | **Needs the owner.** Nothing moves until he acts | an approval, a decision, a login, a budget top-up, a paid run to OK |
| 🟡 | Moving, but waiting on the machine or on another branch | queued for the heavy slot, typecheck lane busy, rebasing after a merge |
| 🔵 | Running right now | building, typechecking, in CI, an agent mid-task |
| 🟢 | Done, nothing to do | live on the integration branch, deploy Ready, verdict passed |
| ⚪ | Paused or parked on purpose | held by the owner, out of scope for now, dropped after a verdict |
| ⚠️ | Broken and nobody owns it yet | a red check on the integration branch, a failed deploy, a stuck lock |

A cloud session on any `train/*` branch is a ⚠️ row in NEEDS YOU ("train session <id> in the cloud: stop it, the train runs locally"), never a 🔵.

Rules: one dot per row, no row without one. 🔴 is only for the owner, never for "an agent should look". A 🔴 row always ends with the exact action he has to take (a command, a click, or a yes/no question).

### Layout

Lead with what needs him. Everything else follows, newest first:

```
🚦 TRAIN  ·  🔴 2 need you  ·  🔵 1 running  ·  🟢 6 live today  ·  slot: <owner or free>

🔴 NEEDS YOU
  🔴 <what>  →  <the one action: command / yes-no question>

🔵 IN FLIGHT
  🔵 train <n>  PR #<n>  <branches>  step: <typecheck|build|CI|merging>  ▓▓▓▓░░ <done>/<total> checks

⏭️ NEXT
  🟡 <branch>  <one-line purpose>  waits: <slot | rebase | branch X>
  ⚪ <branch>  held: <reason>

🟢 LIVE  (last ~8)
  🟢 #<n>  <what it shipped>  deploy ✅ <time>
  ⚠️ #<n>  <what>  deploy ❌ <why>

🤖 AGENTS
  🔵 <agent>  <task>  now: <step>
  🟡 <agent>  <task>  waits: <slot / owner / branch>
```

- Header line first: counts per dot and who holds the heavy slot, so the board reads in one line when nothing is wrong.
- Progress bars (`▓░`, 6 cells) only for things with a real count (checks passed of total, rollouts of a run); never a guessed percentage.
- Times are local and relative where short ("2 min ago", "since 14:05").
- Empty sections collapse to one line (`🔴 NEEDS YOU  ·  nothing 🎉`), never a blank heading.
- Plain words, one line per row. Branch names in backticks only where the owner might copy them.

Mark anything not confirmed from a primary source (GitHub, the slot, the queue file) as "reported" instead of stating it as fact, and never give it a 🟢: a reported-but-unchecked live state is 🟡 until the deploy status says Ready.

## The queue file

The orchestrator rewrites `{{QUEUE_FILE}}` whenever its queue changes (a READY arrives, a train boards, typechecks, merges or goes live, a branch is held or released). Format:

```
updated: <ISO time>
in flight: train <n> - <branches> - <step: assembling|typecheck|build|PR #|merged|live>
boarding next: train <n+1> - <branches>
ready: <branch> - <title>
held: <branch> - <reason (gate, owner, base branch, frozen: <freeze marker>)>
next steps: <one line each>
```
