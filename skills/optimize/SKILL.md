---
name: optimize
description: "Use when the web app feels slow or laggy, a page or tab loads slowly, a click takes long, or someone asks to optimize, profile, speed up or measure performance: page load time, Core Web Vitals (LCP, INP, TTFB, FCP, TBT), long tasks, the API request waterfall, caching, bundle size or first-load JS. Measures the production build and the staging deploy, ranks the costs, fixes the top ones and proves each fix with interleaved A/B runs and statistics (Hodges-Lehmann interval, Cliff's delta)."
argument-hint: "<what feels slow, e.g. 'the settings tab' or 'everything on {{MAIN_ROUTE}}'>"
context: fork
agent: general-purpose
---

# /optimize: measure first, fix the biggest cost, prove it

Run this as one agent from start to finish. The method, earlier results and what didn't work live in
`{{PLAYBOOK_FILE}}`; read it before measuring (create it from the sections in step 5 if it doesn't exist yet).
`$ARGUMENTS` says what feels slow; with none, measure the whole suite of `{{MAIN_ROUTE}}`.

Four rules, each from a mistake an earlier run made:

- **Built app or staging only.** Dev server timings are meaningless (no minification, hot reload, different
  chunking). If a train runs (see the `/train` skill), agents never run the production build themselves: commit, stop
  your servers and end the turn with `READY FOR BUILD: <absolute worktree path>`; the coordinator builds
  (`{{JSTACK_TOOLS}}/coordinator-build.sh`) and leaves the build output in the worktree. Without a train, build
  inside the heavy slot (`source {{JSTACK_TOOLS}}/heavy-lock.sh; heavy_acquire optimize; {{BUILD_CMD}}; heavy_release`).
- **Numbers or nothing.** No fix before a baseline, no claim without at least 10 kept runs per arm, no "faster" unless
  the compare table says so. A fix that speeds up the load and slows down the next click is not a win.
- **Quiet machine.** Every run logs the machine's CPU use and free memory. A block measured while another build or a
  heavy background job ran is thrown away and re-run.
- **Keep behaviour.** Lazy-load, cut waterfalls, trim bundles, stop re-renders; never drop a feature, a permission
  check or a metered/billed call to win time.

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

## What the runs learned

Each /optimize run adds the trap or win it found here, one line with its date. These came from a Next.js 16 app on
Windows; the lessons travel.

- 2026-10-19: a tab that mounts a WebGL graph froze the click for 0.5 s (INP 528 ms). React flushes passive effects
  before paint after a discrete event; `useDeferredValue` on that tab cut INP to 48 ms. Deferring every tab slowed the
  light tabs by 56 ms, so defer only the heavy one.
- 2026-10-19: moving work behind the paint doesn't remove it. Total blocking and click-to-drawn barely moved, and the
  requests the deferred tree makes (images) started later. Report all three numbers, not INP alone.
- 2026-10-19: a shared test database bites. Mid-A/B, another branch's new enum value broke one API route in both
  arms. Merge the commit that adds the value and re-run both arms in one data state.
- 2026-10-19: identical server code still showed the phone TTFB "lower" (331 to 192 ms) between ABAB blocks. Load
  metrics drifted about ±150 ms per block on a laptop. Click metrics are timed in the page and much steadier; repeat
  the ABAB before claiming a load win.
- 2026-10-19: `cp -r .next` breaks the symlinks inside `.next/node_modules`, `mv` keeps them. A build made in another
  worktree links absolutely into that worktree's `node_modules`, so keep that worktree until the A/B ends.
- 2026-10-19: staging loaded the Vercel toolbar (~300 ms frames) and a session recorder. Production has neither, so
  don't try to fix them.
- 2026-10-19: a "What's new" popup opened on every cold load and covered the tabs. Close it in the profile script, or
  every click times out.
