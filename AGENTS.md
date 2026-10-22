# AGENTS.md

Notes for coding agents (Claude Code, Codex, Cursor and friends) working with this repo. Humans: the README is friendlier.

## What this repo is

jstack is a set of Claude Code skills and shell scripts for running many parallel AI coding agents on one machine:

- `skills/train/`: the `/train` skill. Agents work in their own git worktrees and report READY; one orchestrator merges every ready branch, runs one typecheck and one build, opens one PR and merges it only on green checks.
- `skills/train-queue/`: the `/train-queue` skill. A read-only status board: what merged and is live, the train in flight, the queue, and what each agent is doing.
- `skills/optimize/`: the `/optimize` skill. Measures a web app's built output and staging (load time, LCP, INP, TTFB, long tasks, API waterfall, bundle size), fixes the top cost and proves each fix with interleaved A/B runs and statistics.
- `skills/grill-me/`, `skills/grilling/`, `skills/wayfinder/`: planning skills copied as-is from [mattpocock/skills](https://github.com/mattpocock/skills) (MIT, LICENSE in each folder). Don't edit them here; update them from upstream.
- `skills/simplify/`: only a README. `/simplify` is built into Claude Code and its text can't be redistributed.
- `tools/`: `heavy-lock.sh` (one machine-wide slot for builds and typechecks, `server_wait`, `heavy_capped` for a hard RAM ceiling, and `tc_run`, the typecheck lane for worker agents), `run-capped.ps1` (the Windows Job Object behind it), `coordinator-build.sh`, `train.sh`, `new-worktree.sh` (reuses generated code across worktrees, only when complete), `node-memory-watch.ps1` (Windows), and `jstack-env.sh` + `config.example.sh` (settings).

## If a human asked you to install or adapt jstack

Follow [ADAPT.md](ADAPT.md) step by step. Short version:

1. Detect the target project's stack (package manager, build/typecheck/test commands from CI, integration branch, OS, RAM).
2. Copy `tools/` somewhere stable and write `~/.jstack/config.sh` from `tools/config.example.sh`. Scripts read env vars; never edit the scripts to change paths.
3. Copy `skills/train` and `skills/train-queue` (and `skills/optimize` if wanted) into the skills folder and fill every `{{PLACEHOLDER}}` in that installed copy only.
4. Verify: no `{{` left in the installed skills, `heavy_acquire`/`heavy_release`, `server_wait`, `heavy_capped` and `tc_run` work, `new-worktree.sh` creates a worktree with the local env files.
5. Tell the human what you filled in, especially anything you guessed.

Or as a Claude Code plugin: `/plugin marketplace add jayjayholic/jstack` then `/plugin install jstack@jstack`. The skills then run as `/jstack:train` and `/jstack:optimize` and read `~/.jstack/config.sh` for their values.

## If you're changing this repo

- Docs are informal, short, no em dashes. Every change gets a CHANGELOG.md entry with what changed and why.
- Shell scripts: bash, `set -uo pipefail` where it fits, settings only through `JSTACK_*` env vars with defaults in `tools/jstack-env.sh`. Check with `bash -n tools/*.sh`. Never claim a Linux or macOS path works unless someone ran it; mark it UNVERIFIED instead.
- Skill files use `{{PLACEHOLDERS}}` for anything machine- or repo-specific; every placeholder must be in the tables in ADAPT.md.
- Validate the plugin manifests with `claude plugin validate .` after touching `.claude-plugin/`.
- No secrets, emails, private hostnames or people's names in anything committed.
