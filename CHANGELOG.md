# Changelog

Each entry: what changed, and the problem it fixes.

## 2026-10-21 — first public version: the /train skill

**What:** the `/train` skill (`skills/train/`), the shared heavy-job lock (`tools/heavy-lock.sh`), the capped build runner and the train script.

**Why:** shipping ~40 parallel agent branches in a day through one-PR-per-branch meant dozens of full builds and CI runs, constant conflicts and a laptop that kept crashing. Trains verify many branches with one build and one PR.

**Fixed along the way (all in SKILL.md → Lessons):**
- One machine-wide heavy slot instead of separate locks for the train and agents — three parallel Turbopack builds crashed the PC twice.
- Typechecks and `git push` count as heavy too (a 4.9 GB `tsc` ran beside a build; free RAM hit 1.3 GB).
- `server_wait`: no `next start` while a build runs or below 8 GB free.
- Stale-slot timeout 15 → 45 min, and a race when the owner file vanished mid-check.
- Merge gated on zero failed checks; poll deploys via the GitHub API, not the Vercel CLI; check for delayed GitHub webhooks; never `git stash`; recover a zeroed `.git/config` after a crash.
