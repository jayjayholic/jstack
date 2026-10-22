# Changelog

Each entry says what changed and which problem it fixes.

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
