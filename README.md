# jstack: Claude Code skills for parallel AI coding agents on one laptop

[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-d97757)](#quickstart)
[![Skills](https://img.shields.io/badge/skills-%2Ftrain%20%C2%B7%20%2Foptimize-blue)](skills)
[![GitHub stars](https://img.shields.io/github/stars/jayjayholic/jstack?style=flat)](https://github.com/jayjayholic/jstack/stargazers)
[![Last commit](https://img.shields.io/github/last-commit/jayjayholic/jstack)](CHANGELOG.md)

Claude Code skills and scripts for people running a bunch of parallel AI coding agents, each in its own git worktree, on one machine. Their branches ship as a train: one build, one PR, one CI run. One machine-wide lock keeps builds from eating all your RAM (Turbopack, I'm looking at you). Plus `/optimize`, a speed agent that proves its fixes with A/B stats.

```text
/plugin marketplace add jayjayholic/jstack
/plugin install jstack@jstack
```

Or tell your agent "follow ADAPT.md in jayjayholic/jstack for my project". Every rule in here exists because something broke, usually my laptop.

> Made by João Lima ([@jayjayholic](https://github.com/jayjayholic)) while building [Hakutaku](https://hakutaku.ai). Most of the rules were written by the agents themselves, right after they broke something.

Curious how the rest of the work happens before a branch ever boards a train? That's in [HOW-I-WORK.md](HOW-I-WORK.md).

## The short version

Eight agents finish their branches at the same time. If each one opens its own PR, that's eight builds and eight CI runs. My laptop gives up around build three.

So the agents don't build anything. They typecheck, run their own tests and say they're ready. Then one orchestrator agent merges all the ready branches together, builds once, opens one PR and merges it if nothing is red.

Builds, full typechecks and `git push` all share one slot for the whole machine. Only one of them runs at a time.

## Why I made this

I build a lot of features at once. Prototype, check the UI, test it live, move on. Almost all of the code comes from Claude Code agents running in parallel, each one in its own git worktree.

GitHub's normal flow doesn't like that. One PR per feature means one CI run per feature, one full build per feature, one merge conflict per feature, and me babysitting all of it. That flow makes sense for one person opening one PR. With eight agents finishing at once it turns into a traffic jam. I'm honestly hating working with GitHub this way. The checks are fine, the one-PR-per-branch shape is what hurts.

So I stopped shipping branches one at a time and started shipping trains.

## My machine

| | |
|---|---|
| Machine | Avell STORM TWO laptop |
| CPU | Intel Core i7-12700H (14 cores / 20 threads) |
| RAM | 32 GB (keep this number in mind) |
| GPU | NVIDIA RTX 3060 Laptop + Intel Iris Xe |
| Disks | Sabrent Rocket Q 2 TB NVMe + 256 GB NVMe |
| OS | Windows 11, Git Bash + PowerShell, Bun, Docker/WSL |
| Stack | Next.js 16 (Turbopack), TypeScript, tRPC, Prisma, Postgres |

32 GB felt like a lot. Then six agents each decided to "just run a quick `next build`". One Turbopack build eats about 5 GB and ignores `--max-old-space-size`. A full `tsc` is about 4 GB, a `next start` 1 to 2 GB. Three builds plus two typechecks and the laptop doesn't get slow, it just turns off. It crashed three times in one day while I was writing these rules. My laptop is not a fan of parallelism.

## How a train works

```
 agent A ─┐  own worktree, typecheck + own tests
 agent B ─┼─ READY FOR BUILD ──►  orchestrator
 agent C ─┘                           │
                                      ▼
               fresh stage + merge A, B, C   (one train worktree)
                                      │
               one typecheck + one build     (holds the heavy slot)
                                      │
               one PR ─► zero failed checks ─► merge ─► deploy Ready
                                      │
               meanwhile the next train is boarding
```

1. Agents work in parallel, each in its own worktree. They check their work with typecheck and their own tests. They never run a build just to verify.
2. When an agent is done it sends `READY FOR BUILD: <worktree> - <title>` to the orchestrator.
3. The orchestrator merges every ready branch onto a fresh `stage` in one train worktree, runs one typecheck and one `next build`, opens one PR, merges it only if zero checks failed, and tells me when the stage deploy is live.
4. While one train sits in CI, the next one gets put together.

One build can check ten branches. That's why this works on a laptop.

If there's only one branch and nothing else going on, skip the train and open a normal PR. A train with one wagon is just a PR with extra paperwork.

## What's in the repo

```
.claude-plugin/          Claude Code plugin + marketplace manifests (/plugin marketplace add jayjayholic/jstack)
AGENTS.md                notes for coding agents installing or changing this repo
llms.txt                 a short index of the docs, for LLMs
ADAPT.md                 step by step guide (for your agent, or you) to fit jstack to your stack
HOW-I-WORK.md            the rest of my workflow: grilled plans, two-arm research, prototypes, A/B everything
skills/train/
  SKILL.md               the /train skill: when to train, how to brief agents, the gates, and the Lessons log
  orchestrator-brief.md  the prompt for the one orchestrator agent
  worker-clause.md       the block pasted into every coding agent's prompt (build rules + READY format)
skills/optimize/
  SKILL.md               the /optimize skill: the speed agent. Measures the built app and staging, fixes the top cost, proves it with A/B stats
tools/
  config.example.sh      every setting in one file; copy it to ~/.jstack/config.sh
  jstack-env.sh          loads your config and fills in defaults (the other scripts source it)
  heavy-lock.sh          ONE machine-wide slot for heavy jobs (build, typecheck, push) + server_wait
  coordinator-build.sh   one build at a time, waits for free RAM
  train.sh               assemble / build / ship a train, merges only when every check is green
  new-worktree.sh        one worktree per agent, like a fresh clone (copies the local env files git doesn't carry)
  node-memory-watch.ps1  the bouncer: when RAM hits 98%, kills the fattest node/bun process (over 5 GB) before Windows does something worse
```

Every agent gets its own worktree from `new-worktree.sh`, so eight of them can edit the same repo without stepping on each other. The memory watcher is the last line of defense. It's not pretty, but a killed build beats a frozen laptop and a zeroed `.git/config` (yes, that happened).

## Quickstart

The plugin way: run the two `/plugin` lines at the top, then put your values in `~/.jstack/config.sh` (copy `tools/config.example.sh`). The skills show up as `/jstack:train` and `/jstack:optimize`.

The lazy way: clone it and tell your coding agent "follow ADAPT.md in jstack for my project at <path>". It detects your stack, fills in the settings, installs everything and checks it works. That's what I'd do.

The hands-on way:

1. Clone it.
   ```bash
   git clone https://github.com/jayjayholic/jstack.git
   ```
2. Copy the tools somewhere that won't move, and make your config.
   ```bash
   mkdir -p ~/jstack-tools ~/.jstack && cp jstack/tools/* ~/jstack-tools/
   cp ~/jstack-tools/config.example.sh ~/.jstack/config.sh   # then edit it
   ```
3. Install the skill for Claude Code. This is user-wide; for a single project use `<your-repo>/.claude/skills/` instead.
   ```bash
   mkdir -p ~/.claude/skills && cp -r jstack/skills/train ~/.claude/skills/
   ```
4. Fill the `{{PLACEHOLDERS}}` in the installed skill files (the table in [ADAPT.md](ADAPT.md) says what each one is). When `grep -rn "{{" ~/.claude/skills/train` prints nothing, you're done.
5. Paste `worker-clause.md` into every coding agent's prompt. `/train` hands `orchestrator-brief.md` to the one agent that runs trains.
6. Use the lock yourself too.
   ```bash
   source ~/jstack-tools/heavy-lock.sh
   heavy_acquire my-build; npm run build; heavy_release   # anything heavy
   server_wait 8                                          # before a server: no build running and 8 GB free
   ```
7. When two or more branches are ready, type `/train`.

## Settings

The scripts don't have my paths in them anymore. Every setting is an env var with a default, and `~/.jstack/config.sh` is where you set yours. The skill files use `{{PLACEHOLDERS}}` for the same values, since they're prompts and not scripts. The full list, with how to find each value, is in [ADAPT.md](ADAPT.md).

My own config, as an example:

| Setting | Mine |
|---|---|
| `JSTACK_LOCK_DIR` | a folder next to my repos, shared by every agent |
| `JSTACK_INTEGRATION_BRANCH` | `stage` (production only gets release PRs) |
| `JSTACK_INSTALL_CMD` / `JSTACK_CODEGEN_CMD` | `bun install` / `bun run db:generate` |
| `JSTACK_TYPECHECK_CMD` | `bun run typecheck` |
| `JSTACK_BUILD_CMD` | `rm -rf .next && bunx next build --turbopack` |
| `JSTACK_LOCAL_ENV_FILES` / `JSTACK_LOCAL_DIRS` | my env files / `.vercel` |
| `JSTACK_MIN_FREE_GB` | `8` |
| `node-memory-watch.ps1` | `-LimitGB 5 -PressurePercent 98`, running in a background PowerShell |

## Rules that exist because something broke

The full list with dates is in the Lessons section of `skills/train/SKILL.md`. The big ones:

- One heavy slot for the whole machine. Builds, full typechecks and `git push` (my pre-push hook typechecks) all wait for the same lock. Before this, the train had its own lock and the agents had two more, so three Turbopack builds ran at once and the PC crashed. Twice.
- No servers next to a build. `server_wait 8` waits until no build holds the slot and 8 GB is free before any `next start`. A "screenshot build" hit 7.7 GB while another agent had a server up, and free RAM dropped to 1.8 GB.
- The stale slot race. The lock treated a slot as abandoned after 15 minutes, but a train build can take longer, so a second build started next to it. Now it's 45 minutes, and if the owner file vanishes the slot is not treated as stale.
- Merge only with zero failed checks. My merge script didn't stop on red once and merged a PR with a failing job. It was a network flake that time. I got lucky.
- Don't poll Vercel with its CLI. `vercel ls` in a loop grew to 4 GB. Poll the GitHub deployments API instead.
- GitHub webhooks can be late. During a GitHub incident, merges started no CI and no deploy for hours. Check githubstatus.com before you start blaming your own code.
- Never `git stash`. All worktrees share one stash stack, and one agent popped another agent's changes. Use WIP commits.
- A hard crash can wipe `.git/config`. Keep `[core]`, add the remote back from `FETCH_HEAD`, restore branch tracking, run `git fsck`.
- Rate limits hit every agent at the same moment. Resume each one after, and the orchestrator rebuilds whatever got cut off.

## FAQ

**Do I need Next.js?**
No. The point is one heavy slot and one build for many branches. Set `JSTACK_BUILD_CMD` to whatever your expensive step is. Cargo, Gradle, Docker builds, all welcome. They eat RAM too.

**Does it run on macOS or Linux?**
Yes. The lock is plain bash and `mkdir`, and the free RAM check reads `/proc/meminfo` on Linux, `vm_stat` on macOS and PowerShell on Windows. The memory watcher is the only Windows-only piece.

**What if one branch breaks the train?**
The orchestrator throws the whole train away, pushes nothing, finds the branch the error points to, tells its agent, and rebuilds without it. A bad branch slows the train down but never ships.

**Why lock `git push`?**
My pre-push hook runs a full typecheck, about 4 GB. So a push counts as a heavy job.

**How many agents at once?**
On 32 GB, about six working agents. The rest wait in the backlog. More than that and my laptop starts making decisions for me.

## Changelog

Each update says what changed and why. See [CHANGELOG.md](CHANGELOG.md).
