---
name: machine-memory
description: "Use when the dev machine's RAM runs high (80%+ used, swapping, OOM, a frozen PC), before a train build or on each watch tick, or when someone asks who or what is eating memory. Maps memory with mem-map (private bytes, per-agent attribution, WSL/Docker, orphans, lock slots), names the leak pattern, frees memory safely and reports the cause."
---

# Machine memory

When RAM runs high, find which agent started what is using it, and why. On a laptop running a pile of agents, almost every spike is something one of them started. mem-map runs on Windows (PowerShell 5.1+). On Linux and macOS, this skill's patterns and rules still apply, but the script doesn't run (UNVERIFIED there).

## 1. Map

```bash
source {{JSTACK_TOOLS}}/heavy-lock.sh
mem_map                   # totals, groups, per agent, dev processes, WSL + Docker, ports, orphans, lock slots
mem_map -Json             # the same, for scripts
mem_map -Summary          # per-agent peak and average from the sampler log (-SinceMin 180)
```

- **Read private bytes, not working set.** Private bytes are what a process committed. A paged-out 8 GB typecheck shows about 50 MB of working set but its full size here, with `PagedOut` set.
- **Look at "in use" outside processes.** The second line of the map splits memory in use into processes, the system file cache and kernel pools. On Windows the file cache can stay resident (not standby) through a mass install. We've seen 15.8 GB during two concurrent `bun install`s, while every agent process together held under 2 GB.
- **Per agent:** each process is traced to its worktree (current directory, then command line, then an ancestor's), then its branch, then its agent name. The name comes from `<worktree>/.agent`, the lock owner's `@ <path>`, the queue file, or `wt:<folder>` as a last resort.
- **What can't be split:** every subagent's own reasoning runs inside the Claude Code process. Claude Code has no per-subagent resource view; hooks only carry `agent_id` (https://code.claude.com/docs/en/hooks).
- **WSL VM vs containers:** `docker stats` subtracts page cache, so a `vmmemWSL` bigger than the sum of its containers is cache the VM kept.

Done when you can name the top three holders of memory, each with its agent and its pattern from step 2.

## 2. Match the leak pattern

| Pattern | Looks like | Fix |
|---|---|---|
| A production build (ours: 11-12 GB, Turbopack ignores heap flags) | build group, heavy slot held | Only inside `heavy_acquire` + `heavy_capped`. |
| A typecheck run directly (5-8 GB, sometimes two) | `node/tsc`, no `tc_run` lane held | Kill it, and tell that agent to use `tc_run` only. |
| Test servers (2 GB+ each, several at once) | `next-server`, ports 3000-3200 | One at a time after `server_wait`, stopped by whoever started it. |
| WSL VM keeps memory after containers stop | `vmmemWSL` much bigger than the containers | Stop the stack, then drop caches in the VM; set `autoMemoryReclaim=dropCache` and a `memory=` cap in `.wslconfig` (https://learn.microsoft.com/en-us/windows/wsl/wsl-config). |
| Orphans (we found 131 greps, `tail -f`, "stopped" A/B loops) | orphan candidates | `mem_map -Kill orphans -DryRun`, then without `-DryRun`. |
| File cache resident during installs | `!! system file cache` | One install at a time (`mem_guard` first), prune dead worktrees. |
| Nonpaged pool above 1.5 GB | `!! nonpaged pool` | A driver leak, so report it to the human: PoolMon sorted by bytes names the tag (https://learn.microsoft.com/en-us/windows-hardware/drivers/debugger/using-poolmon-to-find-a-kernel-mode-memory-leak). |

Done when every top holder from step 1 has a pattern and a fix, or is the human's own app.

## 3. Free memory safely

- Free things in this order: orphans, then servers nobody is testing, then optional container stacks plus a VM `drop_caches`.
- Kill with WMI terminate. `-Kill` uses `Invoke-CimMethod -MethodName Terminate`, which works where `taskkill` and `Stop-Process` sometimes fail.
- The human's apps, the agent CLI, MCP servers, the test database and `wsl --shutdown` are the human's call. Report them instead.

Done when free memory is back above what the next job needs, or what's left is the human's to decide.

## 4. Rules for every agent

- First thing, write `echo "<name>: <task>" > .agent` in your worktree. Add `.agent` to `.gitignore` or `.git/info/exclude`.
- Type-check only with `tc_run "{{TYPECHECK_CMD}}"`. It waits out a build and waits for free RAM.
- Run one server at a time, after `server_wait {{MIN_FREE_GB}}`, and stop it after the test.
- Kill everything you start (servers, `tail -f`, loops, browsers) before you report. Your agent row in `mem_map` should be empty.
- Before any other heavy step (an install, a big script), run `mem_guard [gb]`.

## 5. Orchestrator duty

- **Before each build and on every watch tick:** run `mem_map`. At 80% used or more, diagnose with steps 1-2 without waiting to be asked, and tell the human the cause and a suggestion in one or two lines.
- **For the whole train:** keep one sampler running, `mem_map -Watch -Every 30`, started detached (`Start-Process powershell -WindowStyle Hidden ...`). It logs one CSV row per process per tick, plus `_machine` (used MB, commit MB, used %), `_syscache` and the WSL VM. After a spike, `mem_map -Summary` says which agent peaked and when.
- **Lock knobs:**
  - `JSTACK_HEAVY_MIN_AVAIL_GB` (12): free RAM a build waits for once it holds the slot.
  - `JSTACK_TC_MIN_AVAIL_GB` (10): free RAM a typecheck lane waits for.
  - `JSTACK_MEM_WAIT_MAX_MIN` (15): after this, a wait gives up and the job runs anyway, still under the hard cap.
  - `MEM_GUARD=0` turns the waits off.

Done when each watch tick has a map, and every tick at 80%+ ended with a cause and a suggestion sent to the human.
