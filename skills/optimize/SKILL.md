---
name: optimize
description: "Use when the web app feels slow or laggy, a page or tab loads slowly, a click takes long, or someone asks to optimize, profile, speed up or measure performance: page load time, Core Web Vitals (LCP, INP, TTFB, FCP, TBT), long tasks, the API request waterfall, caching, bundle size or first-load JS. Measures the production build and the staging deploy, ranks the costs, fixes the top ones and proves each fix with interleaved A/B runs and statistics (Hodges-Lehmann interval, Cliff's delta)."
argument-hint: "<what feels slow, e.g. 'the settings tab' or 'everything on {{MAIN_ROUTE}}'>"
context: fork
agent: general-purpose
---

# /optimize: measure first, fix the biggest cost, prove it

Run this as one agent from start to finish. If this file still has unfilled placeholders (names in double curly braces, for example when installed as a plugin), read `~/.jstack/config.sh` for the shared values, use `${CLAUDE_PLUGIN_ROOT}/tools` as the tools folder, and find the rest as the /optimize section of ADAPT.md describes, asking the owner for anything unknown. The method, earlier results and what didn't work live in
`{{PLAYBOOK_FILE}}`; read it before measuring (create it from the sections in step 5 if it doesn't exist yet).
`$ARGUMENTS` says what feels slow; with none, measure the whole suite of `{{MAIN_ROUTE}}`.

Six rules, each from a mistake an earlier run made (or one Lauren Tan and Brendan Gregg already wrote down):

- **Built app or staging only.** Dev server timings are meaningless (no minification, hot reload, different
  chunking). If a train runs (see the `/train` skill), agents never run the production build themselves: commit, stop
  your servers and end the turn with `READY FOR BUILD: <absolute worktree path>`; the coordinator builds
  (`{{JSTACK_TOOLS}}/coordinator-build.sh`) and leaves the build output in the worktree. Without a train, build
  inside the heavy slot, one build at a time, every arm chained in one background script
  (`source {{JSTACK_TOOLS}}/heavy-lock.sh; server_wait 8; heavy_acquire optimize; {{BUILD_CMD}}; heavy_release`).
- **Numbers or nothing.** No fix before a baseline, no claim without at least 10 kept runs per arm, no "faster" unless
  the compare table says so. A fix that speeds up the load and slows down the next click is not a win. Before trusting
  any number, go through `DEBUG-CHECKS.md`.
- **Quiet machine.** Every run logs the machine's CPU use and free memory. A block measured while another build or a
  heavy background job ran is thrown away and re-run. So is any sample taken with less than 35% of RAM free: the OS is
  already paging and evicting cache, and the timings measure the machine, not the app.
- **Hold the target still.** A deploy of the staging (or measured) environment in the middle of a measurement resets
  its cold starts and caches, so the samples before and after it are different experiments. Hold merges to that branch
  while you measure, or throw away the window that a deploy landed in and re-run it.
- **Keep behaviour.** Lazy-load, cut waterfalls, trim bundles, stop re-renders; never drop a feature, a permission
  check or a metered/billed call to win time.
- **Explain the number.** Before you trust a result, name what limits it ("why not double?") from a trace or counters
  taken during a run, and run the 7-question check in `PERFORMANCE.md`: tuned, within limits, no errors,
  reproduces, matters end to end, and the work really happened. Can't name the limiter? The verdict is "inconclusive".

`PERFORMANCE.md` (next to this file) holds the method (adapted from Lauren Tan's pstack and Brendan Gregg), the metric
targets, trace recipes per layer (browser, React, server, API, ORM, database), the techniques that make screens and
chat feel instant, cases with numbers, and every source with its date. Read it before step 2. Try fixes in the
mantras' order, cheapest first: don't do it, don't do it again, do less, do it later, do it when they're not looking,
do it concurrently, do it cheaper. Log every attempt (kept or reverted) as one row in `decision.tsv`.

## Perceived instant first (the core, before any other number)

What the user sees while waiting matters more than total load time. The complaints that wrote this section were
basic ones: a list that takes seconds to show up, a screen change that blanks the whole UI, and no skeleton even where
something can't be instant. Until now this skill accepted "this can't be faster" and stopped there without adding a
skeleton; **that is now a failure**. Every pass checks the five rules below, and a run that leaves one broken isn't
done, even when every load number is green.

| # | Rule | Check the agent runs |
| --- | --- | --- |
| 1 | The view opens instantly where the user's focus is. The shell (layout, header, background, input, navigation) never unmounts or blanks. | Every load and transition scenario keeps a shell selector and asserts it never disappears (shell remounts = 0); the shell milestone is ≤ 1 s cold on staging. A trace frame where the shell's node is gone is a defect. |
| 2 | Anything that can't be instant gets a skeleton or placeholder in its place, never an empty area. | For each region drawn more than 100 ms after the shell, add a milestone for its skeleton; it must appear within 100 ms of the shell. Screenshot at shell + 100 ms: no empty region. |
| 3 | Keep warm what the user will most likely do next: preload the probable next action (the last ~20 messages of each recent thread, the side list in the page's server preload, hover/viewport prefetch), then refresh in the background. | List the next actions from the screen (top items of each list, the open tab's neighbours). For each: is its data in the server preload or prefetched on render/idle/hover? Measure a prefetch hit and click → content ≤ 100 ms for the top items. |
| 4 | Show the correct state from a cache first, then reconcile. | Warm load and a back-navigation: the region draws from cache (no skeleton, no request on the critical path) and a background refetch replaces it only when the data changed. The behaviour check confirms the refreshed content shows up. |
| 5 | Measure time-to-shell, time-to-first-content and long tasks on every pass; a blank shell is a defect even when total load is fast. | Every report table carries the shell milestone, first content per region, TBT / LoAF blocking and shell remounts, before and after. |

When the limiter can't be removed (a slow provider, a cold function), rules 2 to 4 still apply: skeleton in place,
cache first, prefetch the next step. "Can't be faster" is a reason to fix perception, never a place to stop.

## 1. Set up (once per worktree)

```bash
bash {{JSTACK_TOOLS}}/new-worktree.sh perf/<topic> --install    # or: {{INSTALL_CMD}} && {{CODEGEN_CMD}}
```

Measuring a signed-in app needs a session. Staging uses `{{SESSION_FILE}}` (a stored browser session, for example a
Playwright `storageState` JSON; read-only browsing; when the app redirects to sign-in, ask the human to sign in again,
never type credentials). Locally, mint a session for a test user the way the repo does it (`{{LOCAL_SESSION_CMD}}`).

## 2. Baseline

1. **Staging, the absolute picture** (no build needed):

   ```bash
   {{SUITE_SCRIPT}} {{APP_URL}} {{SESSION_FILE}} staging "$OUT" 10
   ```

2. **Local, for before/after.** Get two builds: the baseline (a clean `origin/{{INTEGRATION_BRANCH}}` worktree at the
   commit your branch contains) and, later, each fix. When a build is back:

   ```bash
   {{BUNDLE_BUDGET_CMD}}                                   # first-load JS per route, checked against your budget file
   echo before > <build dir>/ARM && mv <build dir> <scratch>/perf-base    # MOVE, never cp (see the lessons)
   {{SERVER_CMD}} &                                        # a quick look before measuring; stop it after
   ```

   Smoke the suite first (1 run per scenario): a timeout means stale selectors or an overlay (`DEBUG-CHECKS.md` §1).
   Check the page really works before measuring: call one API route with the session cookie and read the server log.
   One failing request empties a whole panel and every number after it lies.

   For one surface, call `{{PROFILE_SCRIPT}}` directly. It should support: load milestones (first time a CSS selector
   exists), a click and the element that proves it finished, cold vs warm cache, a phone viewport (375x812), CPU
   throttling (4x) and closing a popup that shows on cold loads. (On Git Bash, prefix `MSYS_NO_PATHCONV=1` so
   `/route` arguments aren't rewritten into Windows paths.)

3. **Composition**, when bytes matter: run `{{BUNDLE_ANALYZE_CMD}}`. It compiles like a build, so run it alone with
   nothing else heavy on the machine (inside the heavy slot). List the biggest modules per route and the import chain
   that pulls each one in.

## 3. Read the numbers and rank

`{{COMPARE_SCRIPT}} "$OUT"/<scenario>.json --summary staging` gives n / median / p75 / p95 per metric.

| Field | Meaning | Good |
| --- | --- | --- |
| `ttfb` | `finalResponseHeadersStart` (ignores 103 Early Hints) | ≤ 800 ms |
| `fcp`, `lcp` | paint | ≤ 1.8 s / ≤ 2.5 s at p75 |
| `m_<name>` | first time a milestone selector exists, ms from navigation | as close to the first one as possible |
| `tbt`, `loafBlockingMs`, `worstFrames` | main-thread blocking during load; the worst Long Animation Frames name the script and function | TBT ≤ 200 ms desktop |
| `jsFirstLoadKb`, `jsTransferKb`, `jsFiles` | JS fetched before `load` / until the click | within the bundle budget |
| `apiCount`, `apiEnd`, `apiSlowest` | the load's API calls: count, when the last one ended, the five slowest (`name start+duration`) | no call starting only after another ends (a waterfall) |
| `clickToTarget`, `clickInp`, `clickBlockingMs`, `clickApiEnd` | click to element drawn; worst event duration; blocking frames; API after the click | INP ≤ 200 ms |
| `machineCpuPct`, `freeMemGb` | noise check | quiet and stable across arms |

Rank the problems by **measured milliseconds the user waits** (median and p75), then by bytes. Write the ranked table
into the playbook's "Baseline" section before touching code.

## 4. Fix and prove (one fix at a time)

1. Make the change; `{{TYPECHECK_CMD}}`, the tests of what you touched (`{{TEST_CMD}}`; 1 happy path + 2 edge cases
   per behaviour), the formatter on changed files; commit atomically (Conventional Commits).
2. Get the build (`READY FOR BUILD`, or build in the slot). Label it and run the A/B **interleaved**, one server at a
   time: A B A B, never all of A then all of B. `{{AB_SCRIPT}}` should move each arm's build into place before its
   block, start and stop the server, and refuse a port that's already in use:

   ```bash
   echo after > <build dir>/ARM && mv <build dir> <scratch>/perf-after
   PERF_BEFORE=<scratch>/perf-base PERF_AFTER=<scratch>/perf-after {{AB_SCRIPT}} <session> <scratch>/ab1 5   # ABAB, 10 per arm
   {{COMPARE_SCRIPT}} <scratch>/ab1/<scenario>.json --a before --b after
   ```

3. A metric improved only when the table says `lower`: the Hodges-Lehmann 95% interval of the shift excludes 0 **and**
   Cliff's |δ| ≥ 0.147 (at least a small effect). Bytes are deterministic: one build per arm is enough. Check the other
   surfaces didn't get worse (the next click, opening settings, the 375 px load).
4. Open the pages once by hand in the built app (every locale if text moved) and look at the console.

## 5. Report

Update `{{PLAYBOOK_FILE}}` (baseline, fixes, what didn't work) and any doc that quotes the code you changed. The PR
body (`artifacts/pr-body.md`, from `{{PR_TEMPLATE}}`) carries:

| Surface · metric | Before median (p75) | After median (p75) | Shift (95% CI) | p | Cliff's δ | n |
| --- | --: | --: | --: | --: | --: | --: |

plus the bytes table, the machine state, and what stays slow and why. End with `READY TO PUSH: <worktree> <branch>`;
never push yourself.

## Every run feeds the checklist

`DEBUG-CHECKS.md` (next to this file) is the checklist of method traps, machine traps and known causes, each as
symptom → how to measure → cause → proven fix → verify. Go through it before the baseline, when ranking, and whenever a
number looks wrong.

This is part of the run, not optional: each finding (a cause, a trap, a measurement bug, an hour lost) becomes, the
moment it is confirmed, a row in `DEBUG-CHECKS.md` (generic, app names only as examples) and an entry in
`{{PLAYBOOK_FILE}}` with its numbers and a "test next time" line. Delete rows whose cause can no longer happen. The
report names the rows added.
