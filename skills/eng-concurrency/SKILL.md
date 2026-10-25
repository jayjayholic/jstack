---
name: eng-concurrency
description: "Use when a change touches queues, background jobs, webhooks, retries, cron, sync, locks, approvals or anything that can run twice, late, in parallel or not at all. Commit point, idempotency key, one retry owner."
---

# Concurrency, queues, retries and silent loss: think before, prove after

A distributed step can fail after it did its work and before it said so, and nobody can tell those apart from outside. The recipe: at-least-once delivery, idempotent effects, state you can reconcile, and success recorded only after the effect is durable. Every queue, webhook or long job names its commit point, its idempotency key and the one layer that retries.

## How this pack is used

- **Before** (`/preflight`): answer the questions for the task's tier (S: MUST, M: + SHOULD, L: all + a pre-mortem). An answer that needs a number gets a number or "unknown, measure first". Copy the budgets that apply into the pre-flight with how each is measured.
- **After** (`/unslop`): the static red flags run in `tools/unslop/scan.mjs`; the review agent reads the diff for the `eyes` ones. A red flag is a hypothesis until a confirm recipe produces evidence that a second agent reproduces.
- **Machine part**: `checks.json` in this folder (triggers, questions, budgets, rules, verify). Projects tune it in `.jstack/unslop.json` (rule modes, waivers, extra questions and rules).

<!-- checks:begin (generated from checks.json by tools/unslop/packs.mjs; edit checks.json, then render) -->

## Pre-flight questions

**MUST (asked at every tier)**

- `conc.q.commit-point` What is the commit point? Name the line after which the work is durable. Is any done/seen/200 written before it? _(answer as: text; prevents: silent-loss)_
- `conc.q.idempotency-key` What makes two of these the same, and which database constraint enforces it? _(answer as: text; prevents: duplicates)_

**SHOULD (tier M and L)**

- `conc.q.time-limit` Where does this run, and what is its hard time limit? If the worst case is over it, it needs a queue or workflow with a status, not the request. _(answer as: number; prevents: killed-mid-way)_
- `conc.q.retry-owner` Who retries, how many times, with what backoff and budget? Exactly one layer. Which errors are not retryable? _(answer as: table; prevents: retry-amplification)_
- `conc.q.twice-at-once` If this runs twice at the same moment, or crashes halfway and restarts, what does the user see? _(answer as: text; prevents: duplicates, stuck-state)_
- `conc.q.lease` What proves the owner of a RUNNING row is alive (lease or heartbeat), and what moves it out when it is not? _(answer as: text; prevents: stuck-state)_

**DEEP (tier L, with the pre-mortem)**

- `conc.q.ids-not-positions` Do long-lived references point at ids or at positions and copies? What version check stops a stale writer? _(answer as: text; prevents: skip-or-rerun)_
- `conc.q.state-exits` Draw the state machine, including approved, replaced and cancelled. What is every state's exit? _(answer as: diagram; prevents: orphan-intent)_
- `conc.q.typed-outcome` Does every tool or endpoint result say changed / unchanged / rejected / failed in a typed field, not only in prose? _(answer as: schema; prevents: no-op-read-as-done)_
- `conc.q.shared-resources` Which shared resources (git refs, worktree, ports, build slot, DB rows, cache keys) does this touch that another agent or instance also touches? Pre-mortem: it ran twice and lost one; why? _(answer as: list; prevents: clobbered-shared-state)_

## Budgets

Defaults with their source. The project file `.jstack/budgets.json` wins; `null` means the project sets it the first time a task touches it (pre-flight turns that into a measure-first task).

| key | default | unit | how measured | source |
|---|---|---|---|---|
| `conc.duplicates_per_10k` | 0 | count | duplicate-effect query: GROUP BY idempotency key HAVING count(*) > 1 | Stripe idempotency keys (2017); IETF Idempotency-Key draft |
| `conc.stuck_running_rows` | 0 | count | RUNNING rows whose heartbeat is older than 2 leases | Gray & Cheriton, Leases, SOSP 1989 |
| `conc.attempts_per_request` | 3 | count | attempts per logical request from logs (retry ratio under 10% per client) | Google SRE book ch. 21 (2016) |

## Red flags

A red flag is a hypothesis. /unslop turns it into a finding only with evidence (see Confirm recipes).

| id | what it looks like | why it is slop | detector | severity |
|---|---|---|---|---|
| `conc.empty-catch` | Swallowed error (empty catch, or .catch that returns nothing) | The failure disappears: the caller marks the item done and the sender never retries. | static `conc.empty-catch` (regex) | high |
| `conc.except-pass` | Swallowed error in Python (except: pass) | Same as an empty catch: the error is gone and the work looks done. | static `conc.except-pass` (regex) | high |
| `conc.retry-no-jitter` | Retry loop in a file with no backoff or jitter | Fixed or zero delay retries in lockstep (thundering herd) and multiply load at every layer. | static `conc.retry-no-jitter` (regex) | medium |
| `conc.status-before-work` | Status set to DONE/SEEN/200 before the awaited work | Success recorded before the effect is durable: a crash in between loses the item. | review agent (eyes) | high |
| `conc.check-then-insert` | findFirst/SELECT then create on the same key with no unique constraint or upsert | Two concurrent runs both see nothing and both insert. | review agent (eyes) | high |
| `conc.unawaited-promise` | Fire-and-forget promise (void call, .then without return/catch) | The work can die silently and nobody records an outcome. | eslint, else eyes | medium |
| `conc.running-without-lease` | RUNNING/PROCESSING state with no heartbeat or lease column | No reaper is possible, so a killed worker leaves the row RUNNING forever. | review agent (eyes) | medium |
| `conc.position-cursor` | Persisted array index or position used as a cursor | An insert before the cursor makes the next step skip or repeat. | review agent (eyes) | medium |
| `conc.timing-in-comment` | Timing constants related only by a comment | Someone edits one value and the 'must stay below' relation breaks silently. | review agent (eyes) | low |
| `conc.prose-outcome` | Tool or endpoint returns prose ('ok', 'kept as is') with no typed outcome | The caller (often a model) reads a no-op as success. | review agent (eyes) | medium |

## Confirm recipes

- `conc.empty-catch`: failing-test: make the awaited call throw; assert the item is retried, failed or dead-lettered, never marked done Fix direction: rethrow, or record the failure and let the single retry owner decide. Known false positives: best-effort cleanup with a comment naming why loss is acceptable.
- `conc.except-pass`: failing-test: raise inside the try; assert the outcome is a recorded failure Fix direction: re-raise, or log with context and record a failed state.
- `conc.retry-no-jitter`: failing-test: dependency returns 503 for 30 s under fake timers; assert attempts <= 1 + budget and delays grow Fix direction: capped exponential backoff with full jitter, at one layer only.
- `conc.status-before-work`: failing-test: throw after the status write; assert the item is not left DONE
- `conc.check-then-insert`: failing-test: 3 concurrent calls via Promise.all; assert exactly one row
- `conc.unawaited-promise`: repro-script: kill the process mid-run; count started vs finished records
- `conc.running-without-lease`: failing-test: kill the worker after the side effect; assert retried or failed within lease + interval
- `conc.position-cursor`: failing-test: complete step k, insert a step before k, advance; assert no skip and no repeat
- `conc.timing-in-comment`: failing-test: assert HEARTBEAT_MS * 3 <= STALE_AFTER_MS
- `conc.prose-outcome`: repro-script: run the no-op path; show the reply cannot be told apart from success

## Verification steps

Run in this order after the change; each line is a pass criterion.

1. `conc.v.dup-delivery` 3 concurrent deliveries of one payload -> exactly 1 effect _(test; test runner + Promise.all)_
2. `conc.v.idempotence` run(op); run(op) leaves the state equal to run(op) over generated inputs _(test; fast-check / Hypothesis)_
3. `conc.v.kill-mid-step` kill the worker after the side effect -> row retried or failed within lease + interval, never stuck _(test; test harness + process kill)_
4. `conc.v.fault-after-commit` throw after the commit-point candidate -> item retried or dead-lettered, never marked done _(test; test doubles)_
5. `conc.v.retry-storm` dependency 503 for 30 s -> attempts <= 1 + budget, delays growing with jitter _(test; fake timers + call counter)_
6. `conc.v.stuck-and-dup-queries` stuck-row, duplicate-effect and orphan-intent queries return 0 _(measure; SQL)_
7. `conc.v.state-liveness` every non-terminal state has an exit (enum-driven test) _(test; unit test / TLA+ for critical flows)_

## Triggers

Loaded by `tools/unslop/classify.mjs` when the task says "queue", "background", "job", "webhook", "retry", "retries", "schedule", "cron", "sync", "duplicate", "duplicates", "concurrent", or touches `**/queue*/**`, `**/jobs/**`, `**/workers/**`, `**/webhook*/**`, `**/cron/**`, `**/*retry*`, `**/*worker*`, `**/*scheduler*`.

<!-- checks:end -->

## Tools and how to read them

| tool | how to run it | what number to read | valid only when | trap |
|---|---|---|---|---|
| duplicate-delivery test | `Promise.all` of 3 identical deliveries in the test runner | exactly 1 effect | real database constraint, not a mock | testing the check-then-insert with no concurrency |
| fault injection | make the awaited call throw after the commit-point candidate | item retried, failed or dead-lettered, never marked done | the real state transition code | asserting only that an error was logged |
| fake timers + call counter | dependency returns 503 for 30 s | attempts <= 1 + budget, delays grow with jitter | one retry layer configured | retries inside retries |
| stuck-row and conservation queries | SQL: RUNNING with stale heartbeat; in = done + failed + pending | 0 stuck; the equation holds | run daily, alert on drift | no lease column, so nothing can be reaped |

## Known traps

| symptom | measure | cause | fix |
|---|---|---|---|
| Work silently lost | fault-inject after the side effect | done/seen written before the work | record success after the effect; one retry owner |
| Duplicates under load | concurrent deliveries in a test | no idempotency key or unique constraint | natural key + unique index + upsert |
| Rows stuck in RUNNING | stale-heartbeat query | worker killed mid-step, no lease | lease or heartbeat + reaper on read |

## Sources

Dated sources with their verification tags are in [SOURCES.md](SOURCES.md). Claims tagged unverified there are not stated as fact here.
