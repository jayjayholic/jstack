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
| Backlog | `{{BACKLOG_FILE}}` (`ready`, `running`, `waits for the owner`) | what waits |

Never read a subagent's full transcript file to learn its state (it overflows the context); use its last notification, or ask it with SendMessage only if the owner wants detail.

If the queue file is missing or older than 30 min, ask the orchestrator with SendMessage for its queue (boarding / ready / held with reason) and say the board used its reply.

## Output

One board, at most ~40 lines:

1. **Live**: PR, what it shipped (one line each), deploy state; newest first, last ~8.
2. **In flight**: the train in CI or merging (its branches, step, check status) and who holds the heavy slot.
3. **Next**: the boarding train and the queue in order, each with branch, one-line purpose and gate state (READY / held: reason).
4. **Agents**: one row per running agent: what it works on, its current step, what it waits for (slot, owner, another branch).
5. **Waiting for the owner**: decisions and approvals only the owner can give.

Mark anything not confirmed from a primary source (GitHub, the slot, the queue file) as "reported" instead of stating it as fact.

## The queue file

The orchestrator rewrites `{{QUEUE_FILE}}` whenever its queue changes (a READY arrives, a train boards, typechecks, merges or goes live, a branch is held or released). Format:

```
updated: <ISO time>
in flight: train <n> - <branches> - <step: assembling|typecheck|build|PR #|merged|live>
boarding next: train <n+1> - <branches>
ready: <branch> - <title>
held: <branch> - <reason (gate, owner, base branch)>
next steps: <one line each>
```
