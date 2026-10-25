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
