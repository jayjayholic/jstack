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
- **Look at "in use" outside processes.** The second line of the map splits memory in use into processes, the system file cache and kernel pools. On Windows the file cache can stay resident (not standby) through a mass install. We've seen 15.8 GB during two concurrent `bun install`s, while every agent process together held under 2 GB. When it won't trim, see step 3b.
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
| File cache resident during installs, scans or worktree deletion | `!! system file cache`, processes small | Shared dependencies instead of an install per worktree (step 3c), one install at a time (`mem_guard` first), prune dead worktrees in small batches; when it won't trim, empty it (step 3b). |
| Nonpaged pool above 1.5 GB | `!! nonpaged pool` | A driver leak, so report it to the human: PoolMon sorted by bytes names the tag (https://learn.microsoft.com/en-us/windows-hardware/drivers/debugger/using-poolmon-to-find-a-kernel-mode-memory-leak). |

Done when every top holder from step 1 has a pattern and a fix, or is the human's own app.

## 3. Free memory safely

- Free things in this order: orphans, then servers nobody is testing, then optional container stacks plus a VM `drop_caches`.
- Kill with WMI terminate. `-Kill` uses `Invoke-CimMethod -MethodName Terminate`, which works where `taskkill` and `Stop-Process` sometimes fail.
- The human's apps, the agent CLI, MCP servers, the test database and `wsl --shutdown` are the human's call. Report them instead.

Done when free memory is back above what the next job needs, or what's left is the human's to decide.

## 3b. When the file cache won't let go (Windows)

The system file cache is supposed to sit in standby and give memory back under pressure. Sometimes it stays **resident** (counted as in use) and doesn't trim, even with RAM nearly gone. We saw 16.8 GB of it after a round of `bun install`s, Defender scanning the fresh files, and deleting worktrees out of a repo that had about 368 of them. Killing agents freed nothing, because no agent was holding it.

- **The fix that worked:** Sysinternals RAMMap, `RAMMap64.exe -Ew` (Empty System Working Set). It freed about 14 GB in seconds, twice. It needs admin, so it runs elevated and shows a UAC prompt; **only run it with the human there to click it**. Never try to get around UAC.
- **Getting RAMMap:** download it from `https://live.sysinternals.com/RAMMap64.exe` into the tools folder (for example `tools/rammap/`), then check its Authenticode signature is valid and signed by Microsoft before the first run (`Get-AuthenticodeSignature <exe>`: `Status` must be `Valid` and the signer `Microsoft Corporation`). Keep it there; don't re-download every time.
- **Run it** from PowerShell: `Start-Process <tools>/rammap/RAMMap64.exe -ArgumentList '-accepteula','-Ew' -Verb RunAs`, then `mem_map` again to confirm the cache line dropped.
- **Mass worktree removal refills the cache.** Deleting hundreds of worktrees reads and touches every file in them, and the cache fills right back up. Remove them in small batches (say 20 at a time), check `mem_map` between batches, and empty the cache again if it climbs.
- **Remove worktrees only with `node {{JSTACK_TOOLS}}/worktree-deps.mjs remove <path> [--delete-branch]`.** It unlinks every junction, then runs `git worktree remove` with `core.longpaths`, and falls back to a plain delete. Never a bare `git worktree remove` or `robocopy <empty> <wt> /MIR`: both followed NTFS junctions and deleted the shared stores (step 3c). `rd /s /q` and `rm -rf` don't follow them.
- **Prevention:** worktrees share dependencies (step 3c), remove each worktree when its branch merges (the train's hygiene step), and, if the human agrees, add a Defender exclusion for the dev folder so fresh files aren't scanned one by one. The exclusion is the human's call: it trades some protection for RAM and speed.

Done when the cache line in `mem_map` is back down, or the human has said no to the UAC prompt.

## 3c. Share, don't copy (worktrees)

The cache kept refilling because every worktree made its own copy of what it could have shared. One `bun install` wrote 167,019 files (2.69 GB apparent, hardlinked from the bun cache), took 10-12 minutes and added 4.6-5.7 GB of file cache, with about 10 agents doing it in turn.

**Hard rule: agents never run a plain install in a worktree.** `new-worktree.sh --install` (or `node {{JSTACK_TOOLS}}/worktree-deps.mjs deps` in an existing one) decides: shared by default, an own install only when the branch adds, removes or updates a library (a dependency field of any `package.json`, the lockfile, `bunfig.toml`, `.npmrc`, `patches/`, compared with the branch's merge-base). Generated code works the same way: `worktree-deps.mjs generated` links it unless the codegen inputs (`JSTACK_CODEGEN_INPUTS`) have uncommitted edits. The guard hook denies a bare install and points to the helper.

How it stays correct:
- A linked `node_modules` is a real folder of directory junctions (no admin, no Developer Mode; real symlinks failed with EPERM), one per entry, into a store keyed by the dependency inputs. Workspace packages always point to the worktree's OWN sources, so editing a package in worktree A never reaches worktree B (checked by resolving it from both).
- Node, TypeScript and Bun resolve the real path, so dependencies resolve inside the store and stay single copies. The typecheck passed in a linked worktree.
- Writable caches (`.cache`, `.vite`) stay per worktree; codegen detaches the shared folder before writing.
- Turbopack resolves nothing outside its root, so a Next.js app widens `turbopack.root` to the folder holding both the worktree and the store when `node_modules/next` resolves outside the project.
- A plain `bun install` over a linked folder with an unchanged lockfile is a no-op; with a changed dependency bun replaced that one junction with a real folder and left the store alone (Bun 1.4.3). Still, use the helper.

Measured (Windows 11, 32 GB, other agents running):

| Item, per worktree | Before | After | Decision and why |
|---|---|---|---|
| `node_modules` | 167k files, 10-12 min, +4.6-5.7 GB cache, -0.56 GB disk | ~1,100 junctions, 13-20 s, +27 MB cache, -0.03 GB disk | **Share** by dependency hash; own install only when the branch changed a dependency |
| Workspace `node_modules` | none on a hoisted lockfile | linked with the root | **Share**, same key |
| Generated ORM client (`.generated`) | 68 MB, 1,067 files; regenerating needs the DB | one junction | **Share** by git tree of the codegen inputs (schema + lockfile, which pins the generator version); own when they're edited |
| `.next` | 2.0 GB, 29k files | unchanged | **Keep per worktree**: that branch's build output, cache keyed by project path; delete it with the worktree |
| `tsconfig.tsbuildinfo` | 5.8 MB | unchanged | **Keep**: incremental state of that branch's sources |
| Generated docs site | 15 MB, 121 files, only where built | unchanged | **Keep**: generated from that branch, built on demand |
| Env files, `.vercel` | 5 KB, 10 KB | copied | **Keep copying**: a tool that edits one (e.g. `dotenvx set`) must not rewrite every worktree's file, and they're tiny |
| Playwright browsers | 708 MB once in `%LOCALAPPDATA%\ms-playwright` | | Already shared (global) |
| bun / npm caches | global (`~/.bun/install/cache`, 16,947 entries) | | Already shared; stores hardlink from it |
| Python venvs | none in worktrees (services run in Docker) | | n/a |
| Turning an existing own install into a link | | 26 min, deleting 167k files | Don't convert old worktrees; remove them |

Done when new worktrees show `node_modules: shared` in `worktree-deps.mjs status` and installs in `mem_map` happen only for branches that changed a dependency.

## 4. Rules for every agent

- First thing, write `echo "<name>: <task>" > .agent` in your worktree. Add `.agent` to `.gitignore` or `.git/info/exclude`.
- Type-check only with `tc_run "{{TYPECHECK_CMD}}"`. It waits out a build and waits for free RAM.
- Run one server at a time, after `server_wait {{MIN_FREE_GB}}`, and stop it after the test.
- Kill everything you start (servers, `tail -f`, loops, browsers) before you report. Your agent row in `mem_map` should be empty.
- Before any other heavy step (an install, a big script), run `mem_guard [gb]`.
- Never a plain install in a worktree, and never a bare `git worktree remove`: use `worktree-deps.mjs` (`deps`, `generated`, `remove`), step 3c.
- Search with the Grep and Glob tools, `git grep` or LSP. Never run a recursive grep/find/du over the repo root, the worktrees folder or `node_modules`.
- Where the jstack guard hooks are on (`~/.jstack/guards.json`), the typecheck, build, install and scan rules above are enforced: the denial says how to retry. When a subagent stops, the hook kills the processes it left in its worktree (only ones started after its first command, never the main checkout). That's a seatbelt, not permission to leave things running.

## 5. Orchestrator duty

- **Before each build and on every watch tick:** run `mem_map`. At 80% used or more, diagnose with steps 1-2 without waiting to be asked, and tell the human the cause and a suggestion in one or two lines.
- **For the whole train:** keep one sampler running, `mem_map -Watch -Every 30`, started detached (`Start-Process powershell -WindowStyle Hidden ...`). It logs one CSV row per process per tick, plus `_machine` (used MB, commit MB, used %), `_syscache` and the WSL VM. After a spike, `mem_map -Summary` says which agent peaked and when.
- **Lock knobs:**
  - `JSTACK_HEAVY_MIN_AVAIL_GB` (12): free RAM a build waits for once it holds the slot.
  - `JSTACK_TC_MIN_AVAIL_GB` (10): free RAM a typecheck lane waits for.
  - `JSTACK_MEM_WAIT_MAX_MIN` (15): after this, a wait gives up and the job runs anyway, still under the hard cap.
  - `MEM_GUARD=0` turns the waits off.

- **Daily:** `node {{JSTACK_TOOLS}}/hook-report.mjs --days 1`. A day's cleanup line (processes the stop hook killed) says which agents keep leaving servers behind; tell them.

Done when each watch tick has a map, and every tick at 80%+ ended with a cause and a suggestion sent to the human.
