# jstack

How I ship a product with a swarm of AI coding agents on one laptop — the skills, scripts and hard-won rules behind it. Every change here comes with *what changed and why*, because each one exists to stop a specific thing from breaking again.

> Built and maintained by João Lima ([@LimaTechnologies](https://github.com/LimaTechnologies)) while building [Hakutaku](https://hakutaku.ai). The rules were written by agents, for agents, after watching them fail.

## The problem

I build a lot of features at once. I prototype, validate the UI, test it live, and move on — and almost all of the code is written by AI agents (Claude Code) running **in parallel**, each in its own git worktree, with pipelines of their own.

GitHub's normal flow fights that. One PR per feature means one CI run per feature, one full build per feature, one merge conflict per feature, and a human babysitting all of it. Tests and CI that make sense for one developer opening one PR become a traffic jam when eight agents finish at the same time. Honestly: **I'm hating working with GitHub this way.** The checks aren't wrong, the *shape* is wrong for agentic, parallel work.

So I stopped shipping branches one by one and started shipping **trains**.

## The setup (a.k.a. the victim)

| | |
|---|---|
| Machine | Avell STORM TWO laptop |
| CPU | Intel Core i7-12700H (14 cores / 20 threads) |
| RAM | **32 GB** (this will matter) |
| GPU | NVIDIA RTX 3060 Laptop + Intel Iris Xe |
| Disks | Sabrent Rocket Q 2 TB NVMe + 256 GB NVMe |
| OS | Windows 11, Git Bash + PowerShell, Bun, Docker/WSL |
| Stack | Next.js 16 (Turbopack), TypeScript, tRPC, Prisma, Postgres |

32 GB sounds like a lot until six agents each decide to "just run a quick `next build`". One Turbopack build takes ~5 GB (and **ignores** `--max-old-space-size`), a full `tsc` takes ~4 GB, a `next start` ~1–2 GB. Three builds plus two typechecks and the laptop doesn't slow down — it **dies**. It crashed three times in one day while I was writing these rules. The laptop has opinions about parallelism. Mostly: no.

## The train

A **train** carries every ready branch to the integration branch (`stage`) in one go:

1. Agents work in parallel, each in its own worktree. They prove their work with **typecheck + their own tests only** — they never run a verifying build.
2. When an agent is done it sends `READY FOR BUILD: <worktree> — <title>` to one **orchestrator** agent.
3. The orchestrator merges every ready branch onto a fresh `stage` in one train worktree, runs **one** typecheck and **one** `next build`, opens **one** PR, merges it only when **zero** checks fail, and reports when the stage deploy is live.
4. While one train is in CI, the next one is being assembled.

One build can verify ten branches. That's the whole trick.

What's in here:

```
skills/train/
  SKILL.md               the /train skill: when to train, how to brief agents, the gates, and the Lessons log
  orchestrator-brief.md  the prompt for the one orchestrator agent
  worker-clause.md       the block pasted into every coding agent's prompt (build rules + READY format)
tools/
  heavy-lock.sh          ONE machine-wide slot for heavy jobs (build, typecheck, push) + server_wait
  coordinator-build.sh   one capped build at a time, waits for free RAM
  train.sh               assemble / build / ship a train
```

Paths in the scripts are mine (`/c/dev/hakutaku/...`); change them for your machine.

## Rules that exist because something broke

The full list (with dates) is the **Lessons** section of `skills/train/SKILL.md`. Highlights:

- **One heavy slot for the whole machine.** Builds, full typechecks *and* `git push` (the pre-push hook typechecks) all take the same lock. The train had its own lock and agents had two more → three Turbopack builds at once → crash. Twice.
- **No servers beside a build.** `server_wait 8` waits until no build holds the slot and 8 GB is free before any `next start`. A "screenshot build" hit 7.7 GB while another agent's server ran; free RAM went to 1.8 GB.
- **Stale-slot race.** The lock counted a slot as abandoned after 15 min — but a train build can take longer, so a second build started beside it. Now 45 min, and a vanished owner file means "not stale".
- **Merge only on zero failed checks.** A merge script that didn't stop on red merged a PR with a failing job (it was a network flake — that time).
- **Never poll Vercel with its CLI.** `vercel ls` in a loop grew to 4 GB. Poll the GitHub deployments API instead.
- **Delayed webhooks are a thing.** During a GitHub webhook incident, merges started no CI and no deploy for hours. Check githubstatus.com before blaming yourself.
- **Never `git stash`.** All worktrees share one stash stack; one agent popped another agent's changes. Use WIP commits.
- **A hard crash can zero `.git/config`.** Keep `[core]`, re-add the remote from `FETCH_HEAD`, restore branch tracking, `git fsck`.
- **Rate limits hit every agent at once.** Resume each one afterwards; the orchestrator rebuilds whatever was interrupted.

## Changelog

Every update says what changed and why — see [CHANGELOG.md](CHANGELOG.md).
