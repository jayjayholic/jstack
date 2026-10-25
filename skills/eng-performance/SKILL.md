---
name: eng-performance
description: "Use when a change touches page load, a click that waits, server latency, an agent turn's wall time, logging volume or caching, or someone says slow or laggy. Budgets first, measured on the built app."
---

# Performance and perceived latency: think before, prove after

Nobody wrote a number down before building, and nobody measured the shipped artifact afterwards; then a bad number got explained away. So: a budget per surface before code (0.1 s acknowledge, 1 s flow, 10 s attention), percentiles not means, the built artifact not the dev server, and repeated interleaved runs with an interval before any "faster" claim.

## How this pack is used

- **Before** (`/preflight`): answer the questions for the task's tier (S: MUST, M: + SHOULD, L: all + a pre-mortem). An answer that needs a number gets a number or "unknown, measure first". Copy the budgets that apply into the pre-flight with how each is measured.
- **After** (`/unslop`): the static red flags run in `tools/unslop/scan.mjs`; the review agent reads the diff for the `eyes` ones. A red flag is a hypothesis until a confirm recipe produces evidence that a second agent reproduces.
- **Machine part**: `checks.json` in this folder (triggers, questions, budgets, rules, verify). Projects tune it in `.jstack/unslop.json` (rule modes, waivers, extra questions and rules).

<!-- checks:begin (generated from checks.json by tools/unslop/packs.mjs; edit checks.json, then render) -->

## Pre-flight questions

**MUST (asked at every tier)**

- `perf.q.budget` What is the budget? One number per surface or interaction (LCP, INP, p95 API time, first audio, throughput), and which human limit (0.1 / 1 / 10 s) it serves. _(answer as: number; prevents: no-budget)_
- `perf.q.proof` How will I prove it? Which command and environment (built app, stage, never the dev server), how many interleaved runs, and the decision rule, written now. _(answer as: text; prevents: wrong-artifact, rationalised-regression)_

**SHOULD (tier M and L)**

- `perf.q.feedback` What does the user see at 100 ms, at 1 s and on failure (pending, skeleton or optimistic state, and an error)? _(answer as: text; prevents: no-feedback)_
- `perf.q.shell` What stays on screen while this loads? Draw the loading boundaries; the shell must be outside them. _(answer as: diagram; prevents: blank-shell)_
- `perf.q.io-graph` What is the dependency graph of the I/O? Which awaits truly depend on each other? The rest runs in parallel, preloaded or streamed. _(answer as: diagram; prevents: waterfall)_
- `perf.q.growth` How does cost grow with data? Is any read or computation O(all of the user's data) per interaction? Where are the limit, cursor and cache? _(answer as: text; prevents: unbounded-read)_

**DEEP (tier L, with the pre-mortem)**

- `perf.q.main-thread` What runs on the main thread, and can any task exceed 50 ms? What moves to a worker, a deferred render or a virtualized list? _(answer as: text; prevents: main-thread-freeze)_
- `perf.q.serializes` What serializes? Name every lock, queue and single-flight. Is its key exactly the unit that conflicts? _(answer as: list; prevents: serialization)_
- `perf.q.cold-start` What happens on the first request after a cold start? Would it pass with retries disabled? _(answer as: text; prevents: cold-start-race)_
- `perf.q.agent-latency` For agent and LLM paths: what is the latency budget for a trivial request? Is any tool forced or any pre-fetch unbudgeted? Are independent tools called in parallel? Pre-mortem: it shipped and it's slow; why? _(answer as: number; prevents: forced-round-trip)_

## Budgets

Defaults with their source. The project file `.jstack/budgets.json` wins; `null` means the project sets it the first time a task touches it (pre-flight turns that into a measure-first task).

| key | default | unit | how measured | source |
|---|---|---|---|---|
| `perf.lcp_p75_ms` | 2500 | ms | Lighthouse CI median of >= 5 runs on the built app or stage; RUM p75 in the field | web.dev Web Vitals |
| `perf.inp_p75_ms` | 200 | ms | web-vitals onINP in the field; scripted event duration in the lab | web.dev INP |
| `perf.cls` | 0.1 | score | layout-shift entries without recent input | web.dev CLS |
| `perf.long_task_ms` | 50 | ms | PerformanceObserver longtask on the built app | web.dev Optimize long tasks |
| `perf.input_ack_ms` | 100 | ms | time from click to pending/optimistic state in an interaction test | RAIL; Nielsen 1993 |
| `perf.log_bytes_per_request` | null | bytes | log sink bytes / requests under a 100-request load (team sets it) | OWASP Logging Cheat Sheet |

## Red flags

A red flag is a hypothesis. /unslop turns it into a finding only with evidence (see Confirm recipes).

| id | what it looks like | why it is slop | detector | severity |
|---|---|---|---|---|
| `perf.transition-all` | transition: all (animates layout properties off the compositor) | Every property change animates, including width/height/top, which costs layout and paint per frame. | static `perf.transition-all` (regex) | low |
| `perf.forced-tool-choice` | Forced tool call (tool_choice any/tool) on a model call | Guarantees a tool round-trip even for a trivial question, skips thinking, and some models reject it. | static `perf.forced-tool-choice` (regex) | medium |
| `perf.log-whole-payload` | Whole request/response/payload logged | Log volume grows with payload size and leaks personal data and secrets. | static `perf.log-whole-payload` (regex) | medium |
| `perf.unbounded-findmany` | findMany() with no arguments (unbounded read) | Reads every row; cost grows with the user's data on every call. | static `perf.unbounded-findmany` (regex) | medium |
| `perf.sequential-awaits` | Independent awaits run one after another (waterfall) | Each independent call waits for the previous one. | review agent (eyes) | medium |
| `perf.fetch-after-hydration` | useEffect fetch for first-paint data | The data request starts only after JS loads and hydrates. | review agent (eyes) | medium |
| `perf.loading-gate-blanks-shell` | Loading gate returns a spinner instead of the layout | The whole UI blanks while one region waits. | review agent (eyes) | medium |
| `perf.no-pending-state` | Async click handler with no pending or optimistic state | Nothing happens for seconds; users click again. | review agent (eyes) | low |
| `perf.dev-server-number` | Performance claim measured on the dev server or with n=1 | Dev builds are slower and noisier; the number says nothing about what ships. | review agent (eyes) | high |
| `perf.coarse-lock` | Lock, queue or single-flight keyed wider than the unit that conflicts (per tenant, per user, global) | Independent work waits in one line, so throughput collapses to one item at a time. | review agent (eyes) | medium |
| `perf.one-boundary-for-all` | Fast and slow data behind one loading boundary (a list waits for the slowest panel) | Everything shows as late as the slowest source. | review agent (eyes) | medium |

## Confirm recipes

- `perf.transition-all`: measurement: interaction trace shows Layout/Recalculate Style during the transition Fix direction: transition only transform and opacity (or name the exact properties).
- `perf.forced-tool-choice`: measurement: golden set of trivial prompts shows tool calls > 0 and p95 over budget Fix direction: tool_choice auto; let the model decide.
- `perf.log-whole-payload`: measurement: log bytes per request under load over the budget Fix direction: log selected fields with a size cap.
- `perf.unbounded-findmany`: measurement: endpoint time at 1x, 10x, 100x seeded rows grows linearly or worse Fix direction: take + cursor (keyset pagination), or a justified bound.
- `perf.sequential-awaits`: measurement: server timing shows a serial chain; Promise.all version is faster beyond A/A noise
- `perf.fetch-after-hydration`: measurement: LCP on the built app before vs after server rendering the data
- `perf.loading-gate-blanks-shell`: render: throttled screenshots at 100 ms / 500 ms / 1 s without the shell
- `perf.no-pending-state`: failing-test: delay the request 3 s; assert pending state within 100 ms
- `perf.dev-server-number`: measurement: rerun on the built app with >= 10 interleaved runs
- `perf.coarse-lock`: measurement: push N independent items through the path with the current key and with a key per conflicting unit; time per item grows with N only under the current key Fix direction: key the lock by the smallest unit that truly conflicts.
- `perf.one-boundary-for-all`: render: delay the slow source 3 s on the built app; a screenshot at 1 s shows the fast content missing Fix direction: one boundary per independent source, shell outside all of them.

## Verification steps

Run in this order after the change; each line is a pass criterion.

1. `perf.v.built-artifact` measure the production build and stage, never the dev server _(measure; build + start; stage URL)_
2. `perf.v.executes` prove the change executes (marker, coverage, or a test that fails on the old code) _(test; performance.mark / test)_
3. `perf.v.lab-budget` Lighthouse CI numberOfRuns >= 5, median, maxNumericValue assertions at level error _(measure; lhci)_
4. `perf.v.scaling` 1x, 10x, 100x data on each interaction path: no linear-or-worse growth _(measure; seed script + timer)_
5. `perf.v.cold-start` fresh instance, first request, retries disabled: 10/10 _(test; restart + curl)_
6. `perf.v.ab` interleaved A/B, n >= 10 per arm, Hodges-Lehmann interval + Cliff's delta, decision rule written before _(measure; tools/unslop/stats.mjs or /optimize)_
7. `perf.v.throttled-ux` slow network + 4x CPU: screenshots at 100 ms, 1 s, 3 s show the shell and pending feedback _(render; Playwright)_

## Triggers

Loaded by `tools/unslop/classify.mjs` when the task says "slow", "fast", "faster", "speed", "latency", "lag", "laggy", "performance", "perf", "load", "loading", "waterfall", or touches `**/app/**/page.*`, `**/app/**/layout.*`, `**/pages/**`, `**/routes/**`, `**/*.css`, `**/components/**`, `**/loaders/**`.

<!-- checks:end -->

## Tools and how to read them

| tool | how to run it | what number to read | valid only when | trap |
|---|---|---|---|---|
| Lighthouse CI | `lhci autorun` with `numberOfRuns: 5` and `assert` at level error on the built app or a preview URL | median LCP, TBT, CLS against the budget keys | production build, quiet machine (run `mem-map` first), same throttling every run | one run is noise; a dev server number is not a number |
| web-vitals / PerformanceObserver | `onINP`, `onLCP` in the field; `longtask` and `event` entries in a Playwright run | p75 in the field, max long task in the lab | built app; headed when GPU work matters | headless GPU timings are meaningless |
| Server-Timing / tracing | one span per awaited call on the request path | the serial chain (critical path); sum of independent waits | warm and cold instance measured separately | averages hide the tail; read p95/p99 |
| stats.mjs | `node tools/unslop/stats.mjs` helpers (Hodges-Lehmann, Cliff's delta) or `/optimize` | interval of the shift excludes 0 and beats the A/A noise | interleaved A/B, n >= 10 per arm, decision rule written before | stopping when the number looks good |

## Known traps

| symptom | measure | cause | fix |
|---|---|---|---|
| "It is faster" from one run | n >= 10 interleaved runs, interval | noise read as a win | repeat, interleave, report the interval |
| Fast locally, slow on stage | measure stage with the same script | dev server or warm cache measured | budget on the built artifact and stage |
| Optimisation shipped, nothing changed | a marker or test that fails on the old code | the new path never executed | prove it executes before timing it |
| Waterfall after hydration | trace of the first paint request chain | first-paint data fetched in an effect | fetch on the server, stream the shell |

## Defers to

`/optimize` for deep A/B work and the DEBUG-CHECKS table; `machine-memory` before any measurement.

## Sources

Dated sources with their verification tags are in [SOURCES.md](SOURCES.md). Claims tagged unverified there are not stated as fact here.
