# Performance log and the optimize loop

Part of the `machine-memory` skill. `mem_map` answers "who holds memory right now"; the performance log answers "who used the CPU and memory over the last hour, day or two weeks", so an agent can watch the machine on a schedule and keep finding cheaper ways to do the same work.

## 1. Install once

```bash
node {{JSTACK_TOOLS}}/perf/perf.mjs install --task JstackPerf --interval 60 \
  --lock-dirs "<heavy lock dir>;<tc lock 1>;<tc lock 2>" --queue <train queue file>
node {{JSTACK_TOOLS}}/perf/perf.mjs status      # collector alive, last tick, its own measured cost
```

- Windows: compiles `perf-snap.cs` with the C# compiler that ships with Windows (no binary in git), copies the scripts to `~/.jstack/perf/app`, registers a scheduled task (at logon, and every 5 minutes it restarts the collector if it died; battery-safe; no admin, no UAC). Run `install` again after pulling jstack. `uninstall [--purge]` removes it.
- macOS/Linux: the collector falls back to `ps` (UNVERIFIED, never run on a Mac here); start `collect.mjs` from launchd or a systemd user unit yourself.
- Store: `~/.jstack/perf` (`JSTACK_PERF_DIR`). One JSON line per tick in `raw/<day>.jsonl`, past days gzipped, 5-minute rollups kept 90 days, hourly 400 days, raw 14 days (config.json). Command lines are redacted before they're written (tokens, `--token=`, `KEY=value`, Bearer, URL credentials, long random strings) and cut to 200 characters.

What a tick holds: per (process name, kind, worktree or app) group: CPU % over the interval (100% = one core, like the Grafana "CPU by process name" panel), private and working-set MB, process count, I/O KB/s, how many were born this tick. The heaviest single processes with pid, age and redacted command. Machine: CPU % of all cores, RAM used, commit and limit, file cache, pagefile in use, disk queue and busy %, and `unacc`: CPU that no live process explains (processes that lived less than a tick, plus interrupts). Who holds each heavy-lock slot. The collector's own cost.

Attribution is mem-map's: worktree from the process's current directory, its repo root, its command line, else its nearest ancestor's; agent names come from `mem-map.ps1 -Agents` (the `.agent` file, the lock owner, the train queue), cached in `agents.json`. Processes outside any worktree are grouped by their top ancestor (`app:chrome`, `app:claude`, `app:svchost`).

## 2. Read it

```bash
P="node {{JSTACK_TOOLS}}/perf/perf.mjs"
$P top --since 60m                  # CPU by process name, mean and max (add --sort mem, --by agent|wt|kind|both)
$P agents --since 24h               # per agent / worktree
$P spikes --since 24h               # episodes over 85% CPU or 90% RAM and who was busy
$P at "2026-10-25 14:05" --window 10m   # what ran during that freeze
$P patterns --since 24h             # grep storms, duplicate typechecks, parallel builds, long-lived browsers, idle servers, churn
$P panel --since 24h --open         # the static HTML panel (stacked CPU/RAM by name and agent, lock timeline, hours)
```

Every command takes `--json`. `csv` exports per-tick rows (Grafana's CSV data source plugin can read the file if you want Grafana; nothing else needs it).

Limits: a process born and gone between two ticks is invisible except through `unacc` (a 60 s tick misses most single `grep` calls; lower the interval with `install --interval 10` for an hour when `unacc` is high). The subagents inside one Claude Code process can't be split, the same as in `mem_map`.

## 3. Watch it on a schedule

On each watch tick (the orchestrator's, or a `/loop 15m` agent):

1. `$P status`: the collector is running and its last tick is under two intervals old. If not, `schtasks /Run /TN <task>` (or `install` again) and say so.
2. `$P spikes --since 30m` and `$P patterns --since 2h`. A spike or a pattern gets one or two lines to the human: what, which agent, the fix from the pattern table in `SKILL.md` step 2.
3. Once a day: `$P top --since 24h` and `$P top --since 24h --sort mem`, then step 4 on the top 10 of each.

Done when each tick has a status line, and every spike or pattern was named with its agent.

## 4. The optimize loop

For each high consumer (CPU or RAM, by process name and by agent), find something that does the same job cheaper, prove it, and only then switch.

1. **Name the consumer and its job.** From `top` and `at`: what process, which agent, what command (the redacted `cmd`), how often. A consumer that is the human's own app (browser, editor, chat app), the OS (System, svchost, Defender, Memory Compression) or the agent CLI itself is recorded as `no-alternative` or `human-decision` with the reason, not benchmarked.
2. **Check the ledger first.** `$P ledger list` (`~/.jstack/perf/ledger.jsonl`). Don't benchmark the same pair again unless the versions changed. Consumers another agent is already benchmarking are recorded as `in-progress-elsewhere`.
3. **Research alternatives from primary sources only:** the tool's docs, release notes, the alternative's repo and its own benchmarks, an issue with numbers. Write down each claim's URL. A blog post is a lead, not a source.
4. **Benchmark interleaved, same workload, same machine:**
   ```bash
   $P bench --consumer "<name>" --a "<current command>" --b "<alternative>" --runs 5 --cwd <same dir> \
     --alt "<alternative, version>" --source <url> --record
   ```
   It runs A and B alternately (switching which goes first each round), each inside a Windows Job Object, and measures the whole process tree: wall time, CPU time (user + kernel of every process) and peak committed memory. Results must be equal: exit code plus a hash of the output (`--same exit` only when the output is legitimately different each run, like timestamps, and then compare the output by hand). At least 3 runs; medians.
5. **Verdict:** `adopt` only when B is faster AND uses less CPU AND has a lower peak, with the same result. Anything else is `reject` with the reason (`not better on peak`, `results differ`). The ledger keeps the numbers either way, so nobody repeats it.
6. **Port the winner.** Generic changes (a jstack tool, a hook, a skill) go to jstack; project changes go on a branch in that project with READY to the orchestrator, never pushed by you. Then watch `top` for a day to see the consumer actually dropped, and add a ledger line with the before/after.

Done when every top-10 consumer of the day has a ledger line: adopted with numbers, rejected with numbers, or why there is nothing to try.

## 5. The warden: what runs on its own every minute

The collector runs the warden after each tick (`tools/perf/warden.mjs`). It's deterministic, needs no session and no LLM, and costs a few milliseconds a tick. Every action goes to `~/.jstack/perf/actions.jsonl` with what, why, the metric before and, one tick later, available RAM after: that log is its memory. `perf.mjs actions --since 24h` reads it.

- **Orphans.** Kills a process whose parent is gone when it's a known dev tool and nobody can be waiting for it: `grep`, `rg`, `find`, `xargs`, `tail`, `sleep`, `tsc`, `tsgo`, `esbuild` after 10 minutes; `node`/`bun` inside an agent worktree and automation browsers after 30 minutes idle (under 1% of a core the whole time). Never: the agent CLI, MCP servers, Docker/WSL, editors and language servers, jstack's own tools, anything in the heavy-lock holder's worktree, a `keep-browser` pid, a main checkout's server (that's the human's local app), anything whose command line it couldn't read, or a tree with any of those inside. At most 10 a tick.
- **RAM.** Under 10% available it runs the RAM clean task (`JSTACK_RAM_CLEAN_TASK`), sharing ram-clean.ps1's cooldown stamp, and at most once per 10 minutes.
- **Hung tests.** A test at 90%+ of a core for 15+ minutes goes to `notices.jsonl` (and a trigger), once. Never killed: its agent decides.
- **Hung dev tools.** A heavy dev tool (`tsc`, `tsgo`, `esbuild`, `next build`) under 1% of a core for 15+ minutes with 2+ GB private is hung: killed. If it is still alive 10 s later, its node/bun launcher is killed too (a native child can't be terminated while its launcher holds it; a terminate on the child alone stays pending). The launcher is never killed when it is the agent CLI, a shell, a launcher holding other children, or anything protected: that is logged as `skip`. Both kills go to `actions.jsonl`, and `notices.jsonl` gets a `hung-tool-killed` entry with the GB freed and the worktree, so its agent knows to rerun.
- **Idle Docker stack** (only when `--docker-project` is set): stopped (`docker compose stop`, volumes kept, `undo` in the log) after 30+ minutes with no container above 2% CPU, no TCP client on its published ports and no process matching `--docker-busy`. The first 30 minutes after the collector starts only observe.
- **Triggers** for the optimizer (`triggers.jsonl`, each type and key at most once per 30 minutes): `ram-low`, `hung`, `new-top-consumer` (a name entering the 15-minute top 5 by CPU or RAM; the first 15 ticks only learn), `new-heavy-process` (a never-seen name at 50%+ of a core or 1 GB+), `regression` (machine CPU over 15 minutes above the floor's p75 + 15 points), `respawning-orphan` (the same command killed 3 times in 2 hours: find what launches it).
- **Modes:** `install --warden-mode act|dry|off` (`dry` logs every decision without acting). A failing step is logged as an `error` action and the rest of the tick goes on.

One-time changes the owner approved, done by command, logged as actions: `perf.mjs search-exclude` keeps the dev roots (`C:\dev`, `~/.claude`, `~/.jstack`, `~/.bun`, `~/.cache`, the npm/pnpm/Yarn caches, Playwright's browsers, plus `--add a;b`) out of Windows Search through the Crawl Scope Manager API. No admin needed on the machine where this was built; when it is, it writes a one-click elevated `.cmd` and says so. `search-scope.exe include <folder>` undoes it.

## 6. The optimizer agent: the loop the warden can't do

The warden only does what needs no judgment. Finding a cheaper way to run the same work needs reading, research and a benchmark, so an agent does it, in the background, one at a time: the orchestrator's watch runs `perf.mjs optimizer due` every round and launches one when it exits 0 (a pending trigger, or 30 minutes since the last run).

**There is a floor.** 32 GB, 20 threads and N agents doing real builds, typechecks and tests: much of the load is the work itself. `perf.mjs floor --write` estimates it (the p25 of 15-minute windows with agent work running, over 24 h) and says how far above it the last 15 minutes are. Report gains against the floor, not against zero. A consumer that is the legitimate work (a build in the slot, a typecheck in its lane, the agent CLI) is `at-floor` in the ledger with the evidence, and nobody benchmarks it again until the workload changes (new tool version, new kind of job, a jump in its share).

**Priority = expected saving.** Mean CPU or RAM above the floor × how often it runs × how likely an alternative exists (a known cheaper tool or flag, an orphan or duplicate pattern) − the risk of changing it. Take the top one or two per run; don't chase noise (anything under about 2% of a core or 200 MB on average), and don't re-bench what the ledger already settled.

**What it may do by itself:** low-risk and reversible only. A jstack tool, script or skill change proven by `bench` (faster AND lighter, same output) goes to a branch with tests and READY to the orchestrator; a config the warden owns (its thresholds, `--protect`, the Docker project) via `perf.mjs install`; ledger and floor updates. **What it only proposes:** anything that touches the human's apps, system settings that need admin, deleting data, stopping something someone might be using, changing a project's code or dependencies (that's a branch for the project's own agents), or squeezing the last percent at the cost of disruption.

## 7. The prompt for the optimizer agent

Launch as a background agent on a cheap model, never waiting for it:

```
You are the machine's performance optimizer, one background run. Follow the machine-memory skill's PERF.md sections 4, 6 and 7 exactly. P="node {{JSTACK_TOOLS}}/perf/perf.mjs".
1. `$P optimizer start` (if it says started:false, stop: another run is active). Read the pending triggers it prints.
2. Context: `$P floor --write`, `$P top --since 60m`, `$P top --since 60m --sort mem`, `$P agents --since 60m`, `$P patterns --since 2h`, `$P actions --since 2h`, `$P notices`, `$P ledger list`.
3. Pick at most two consumers by expected saving above the floor (PERF.md 6). Skip anything the ledger already settled (adopt, reject, at-floor, in-progress-elsewhere, human-decision) unless the workload changed. Mark the legitimate work at-floor with evidence: `$P ledger add --consumer ... --verdict at-floor --evidence ... --why ...`.
4. For each pick: research alternatives from primary sources only (docs, release notes, repos, issues with numbers; keep the URLs), then `$P bench --consumer ... --a "<current>" --b "<alternative>" --runs 5 --source <url> --record` on the same workload. Adopt only if faster AND less CPU AND lower peak with the same output.
5. Apply only low-risk reversible winners yourself (PERF.md 6): a branch in jstack with tests, READY to the orchestrator; never push, never build, never take the heavy slot, never kill anything (the warden does that), never touch the human's apps or anything needing admin. Everything else: `$P ledger add --verdict human-decision --alternative ... --why ...`.
6. `$P optimizer finish --summary "<one line: what you looked at, verdicts, gain vs floor>"`. Your final message: that line, plus one line per proposal that needs the human. Nothing else.
```

Done when each run ends with `optimizer finish`, a ledger line per consumer it looked at, and proposals only where a human must decide.
