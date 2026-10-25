---
name: eng-machine
description: "Use when a change or a run starts servers, builds, browsers, installs, polls or fans out agents, or the machine is slow, swapping or crashed. Admission control, bounded lifetimes, kill what you start."
---

# Machine resources: RAM, processes, browsers, waits: think before, prove after

A workstation is a queue with a hard capacity (RAM) and no admission control. Every failure is unbounded admission (too many jobs at once), unbounded lifetime (servers and browsers left running) or a wasteful wait (polling instead of being notified). Budget peak memory before starting, take the heavy lock for builds, own and kill every process you start, and wait on events with a deadline.

## How this pack is used

- **Before** (`/preflight`): answer the questions for the task's tier (S: MUST, M: + SHOULD, L: all + a pre-mortem). An answer that needs a number gets a number or "unknown, measure first". Copy the budgets that apply into the pre-flight with how each is measured.
- **After** (`/unslop`): the static red flags run in `tools/unslop/scan.mjs`; the review agent reads the diff for the `eyes` ones. A red flag is a hypothesis until a confirm recipe produces evidence that a second agent reproduces.
- **Machine part**: `checks.json` in this folder (triggers, questions, budgets, rules, verify). Projects tune it in `.jstack/unslop.json` (rule modes, waivers, extra questions and rules).

<!-- checks:begin (generated from checks.json by tools/unslop/packs.mjs; edit checks.json, then render) -->

## Pre-flight questions

**MUST (asked at every tier)**

- `mach.q.peak` What is the measured peak RAM of one instance of each heavy job I will run, and how many run machine-wide right now? _(answer as: number; prevents: uncapped-parallel)_
- `mach.q.teardown` Which processes, servers and browsers will I start, which handle owns each tree, and what kills it on success, failure and interrupt? _(answer as: table; prevents: orphans, forgotten-browser)_

**SHOULD (tier M and L)**

- `mach.q.lock` Which lock or slot will I take, and is it enforced by a hook or only by good intent? _(answer as: text; prevents: lock-bypass)_
- `mach.q.reuse` Is there already a running server, install or browser I can reuse instead of starting another? _(answer as: text; prevents: duplicate-instances)_
- `mach.q.browser-profile` Which browser, profile or tab will I use, and is it isolated from the owner's own windows? _(answer as: text; prevents: owner-browser-hijack)_
- `mach.q.waits` For every wait: what event, what timeout, what happens on timeout? _(answer as: table; prevents: busy-wait)_

**DEEP (tier L, with the pre-mortem)**

- `mach.q.per-session-cost` Does any tool or local server I add cost RAM per session, and what is the total at max sessions? _(answer as: number; prevents: per-session-spawn)_
- `mach.q.budgets` What are my budgets: wall-clock deadline, max agents, max tool calls, and who stops me? Pre-mortem: the machine froze an hour from now; what did I start? _(answer as: number; prevents: runaway-agents)_

## Budgets

Defaults with their source. The project file `.jstack/budgets.json` wins; `null` means the project sets it the first time a task touches it (pre-flight turns that into a measure-first task).

| key | default | unit | how measured | source |
|---|---|---|---|---|
| `ram.heavy_job_peak_gb` | null | GB | peak summed private bytes of the job's tree (mem_map / heavy_capped log) | Little's law; USE method |
| `mach.orphans_after_task` | 0 | count | processes started after task start whose parent is gone, plus ports still bound | Release It! Steady State |
| `mach.automation_browsers_after_task` | 0 | count | automation browser processes (debugging port/pipe, non-default profile) after the task | Playwright Browser.close docs |

## Red flags

A red flag is a hypothesis. /unslop turns it into a finding only with evidence (see Confirm recipes).

| id | what it looks like | why it is slop | detector | severity |
|---|---|---|---|---|
| `mach.kill-by-name` | Kill by process name (taskkill /IM, pkill, killall) | Kills every process with that name: other agents, the owner's tools, the agent host itself. | static `mach.kill-by-name` (regex) | high |
| `mach.while-true-sleep` | while-true sleep loop (busy wait with no exit or deadline) | Waits forever or polls blindly; holds a slot and hides a stall. | static `mach.while-true-sleep` (regex) | medium |
| `mach.launch-no-close` | Browser/context launched with no close in finally or fixture teardown | Windows pile up and eat RAM; a crash leaves them open. | review agent (eyes) | medium |
| `mach.unbounded-parallel` | Promise.all / & / background over heavy jobs with no concurrency limit | Peak RAM = jobs x peak per job; the machine swaps or crashes. | review agent (eyes) | high |
| `mach.heavy-outside-lock` | Typecheck/build/install outside the machine-wide lock | Advisory locks only work when everyone takes them. | review agent (eyes) | high |
| `mach.agent-fanout` | Agent spawn loop with no cap or deadline passed to children | Agents multiply and outlive the task. | review agent (eyes) | medium |

## Confirm recipes

- `mach.kill-by-name`: static-proof: the command is in a script Fix direction: kill the tree you started by PID (taskkill /PID <pid> /T /F, kill -- -<pgid>) or a Job Object.
- `mach.while-true-sleep`: repro-script: run with the awaited event never happening; it never exits Fix direction: wait on the event (process exit, health endpoint with a deadline, a watcher) with an explicit timeout.
- `mach.launch-no-close`: measurement: automation browser count after the run > 0
- `mach.unbounded-parallel`: measurement: peak commit during the run vs the budget
- `mach.heavy-outside-lock`: repro-script: guard log shows the command without the wrapper
- `mach.agent-fanout`: measurement: live agents vs the cap during the run

## Verification steps

Run in this order after the change; each line is a pass criterion.

1. `mach.v.orphans` no process from this task alive (PID tree, start time, command line); ports released _(measure; mem_map; netstat -ano / ss -ltnp)_
2. `mach.v.browsers` automation browser processes = 0; tabs I created closed; owner tabs untouched _(measure; process list by profile dir)_
3. `mach.v.lock-audit` every heavy command ran under the wrapper (guard log violations = 0) _(measure; hook-report.mjs)_
4. `mach.v.budget-report` peak RAM / commit %, concurrent heavy jobs, agents spawned, wall-clock vs deadline _(measure; mem_map / machine-memory)_
5. `mach.v.waits` no bare sleeps; every wait has a timeout _(test; scan.mjs --domain machine)_

## Triggers

Loaded by `tools/unslop/classify.mjs` when the task says "ram", "memory", "oom", "crash", "freeze", "process", "processes", "orphan", "browser", "playwright", "server", "dev server", or touches `scripts/**`, `tools/**`, `**/*.sh`, `**/*.ps1`, `**/playwright*.{ts,js,mjs}`, `**/.mcp.json`, `**/docker-compose*.yml`.

<!-- checks:end -->

## Tools and how to read them

| tool | how to run it | what number to read | valid only when | trap |
|---|---|---|---|---|
| mem-map | `tools/mem-map.ps1` (private bytes per process tree and per agent) | free RAM before and after; who holds what | measure before the heavy job starts | working set instead of private bytes |
| heavy-lock | `tools/heavy-lock.sh` around build, typecheck, test suites | one slot holder; queue wait time | every heavy command goes through it | a build started outside the lock |
| process ownership | kill by PID or port, never by image name | no orphan trees after the task | record the PID you started | `taskkill /IM node.exe` killing other agents and the CLI |
| bounded waits | a loop with a deadline and a reason, or an event/notification | the wait ends by condition or timeout | timeout printed with what was waited for | `while true; sleep` that never ends |

## Known traps

| symptom | measure | cause | fix |
|---|---|---|---|
| Machine freezes during builds | mem-map + lock slot list | parallel heavy jobs | heavy-lock; cap concurrent agents |
| RAM never comes back | orphan process tree after the task | servers or browsers not killed | kill what you start; cleanup hooks |
| An agent waits forever | process list + its log | poll without deadline | deadline + event-driven wait |

## Defers to

`machine-memory` for live diagnosis.

## Sources

Dated sources with their verification tags are in [SOURCES.md](SOURCES.md). Claims tagged unverified there are not stated as fact here.
