---
name: eng-data-quality
description: "Use when a change touches ingestion, ETL and pipelines, extraction, embeddings, uploads, connectors, dedupe, thresholds or nightly batch jobs. Screen input, keep unknowns, check each stage's output, alert on yield."
---

# Ingestion, pipelines and data quality: think before, prove after

Pipelines fail quietly: junk gets in, unknown input aborts a whole batch, a cap truncates without a trace, a stage reports complete while half its items failed, and learned data goes stale. Screen content at the door, keep and count what you do not understand, check each stage's postcondition, report caps with the remainder, and alert when yield drops against a golden set.

## How this pack is used

- **Before** (`/preflight`): answer the questions for the task's tier (S: MUST, M: + SHOULD, L: all + a pre-mortem). An answer that needs a number gets a number or "unknown, measure first". Copy the budgets that apply into the pre-flight with how each is measured.
- **After** (`/unslop`): the static red flags run in `tools/unslop/scan.mjs`; the review agent reads the diff for the `eyes` ones. A red flag is a hypothesis until a confirm recipe produces evidence that a second agent reproduces.
- **Machine part**: `checks.json` in this folder (triggers, questions, budgets, rules, verify). Projects tune it in `.jstack/unslop.json` (rule modes, waivers, extra questions and rules).

<!-- checks:begin (generated from checks.json by tools/unslop/packs.mjs; edit checks.json, then render) -->

## Pre-flight questions

**MUST (asked at every tier)**

- `dq.q.postconditions` What is each stage's postcondition, and where is it checked? Can a stage report complete while part of its input failed? _(answer as: table; prevents: false-complete)_
- `dq.q.never-ingest` What should never be ingested from each source (CI mail, lockfiles, binaries, spam)? Is there a fixture for each? _(answer as: list; prevents: junk-ingested)_

**SHOULD (tier M and L)**

- `dq.q.unknown-input` What happens to an input never seen before: unknown type, empty file, a 404, a binary, a huge file? _(answer as: table; prevents: crash-on-unknown)_
- `dq.q.caps` Where are the caps? What does the reader see when one is hit? _(answer as: list; prevents: silent-truncation)_
- `dq.q.yield` What is the expected yield of each automated job, and what alerts on zero? _(answer as: number; prevents: zero-yield)_
- `dq.q.judge-evidence` What evidence does each automated decision-maker (judge, filter, threshold) see? Is it what a human would use? _(answer as: text; prevents: judge-on-snippets)_

**DEEP (tier L, with the pre-mortem)**

- `dq.q.golden-set` Which golden set measures quality? What is the bar, the per-item minimum and the interval? _(answer as: number; prevents: unmeasured-quality)_
- `dq.q.tasks-survive` Which user tasks must survive this change? Is there a before/after script for each? _(answer as: list; prevents: lost-core-view)_
- `dq.q.learned-data` Which learned or derived data does this rely on? Where is its source, as-of date and invalidation trigger? _(answer as: table; prevents: stale-learned-data)_
- `dq.q.entry-points` How many entry points reach this pipeline? Can they be one? _(answer as: number; prevents: fragmented-paths)_

## Budgets

Defaults with their source. The project file `.jstack/budgets.json` wins; `null` means the project sets it the first time a task touches it (pre-flight turns that into a measure-first task).

| key | default | unit | how measured | source |
|---|---|---|---|---|
| `dq.inconsistent_complete_rows` | 0 | count | reconciliation query: complete rows with fewer outputs than inputs | Deequ (PVLDB 2018); design by contract |
| `dq.junk_rate_admitted` | null | ratio | hand-labelled random sample of 50 admitted items, with a Wilson interval | Dodge et al., EMNLP 2021 |
| `dq.oldest_in_progress_min` | null | min | age of the oldest in-progress job | SRE Workbook ch. 5 |

## Red flags

A red flag is a hypothesis. /unslop turns it into a finding only with evidence (see Confirm recipes).

| id | what it looks like | why it is slop | detector | severity |
|---|---|---|---|---|
| `dq.fetch-no-status` | fetch() result used in a file that never checks res.ok or status | A 404 page or an error body gets parsed, stored and indexed as content. | static `dq.fetch-no-status` (regex) | medium |
| `dq.unknown-type-throw` | Ingest path throws on an unknown type or kind | One new type fails the whole ingest instead of degrading to a generic type with a flag. | static `dq.unknown-type-throw` (regex) | medium |
| `dq.paid-before-screen` | extract()/embed()/model call before any content screen | Junk is paid for, then stored. | review agent (eyes) | high |
| `dq.complete-after-swallow` | status = complete after a try that swallows errors, or with no count reconciliation | Failed embeddings or chunks hide behind a complete status. | review agent (eyes) | high |
| `dq.zero-yield-success` | Job logs done with 0 changes as success | A filter removing 100% of candidates looks like a quiet night. | review agent (eyes) | medium |
| `dq.stacked-thresholds` | Confidence thresholds stacked with AND, no funnel counts logged | Each threshold is reasonable; together they block everything. | review agent (eyes) | medium |
| `dq.learned-text-no-source` | Learned note or report injected into a prompt with no source or as-of date | A stale lesson beats fresh evidence. | review agent (eyes) | medium |
| `dq.degenerate-output` | Stage output accepted with no sanity bound (one segment, one label for everything, empty, output/input ratio far off) | A stalled or collapsed stage still reports success and its junk flows downstream. | review agent (eyes) | medium |

## Confirm recipes

- `dq.fetch-no-status`: failing-test: serve a 404 fixture; assert it is rejected before indexing Fix direction: check res.ok and the content type; add a timeout.
- `dq.unknown-type-throw`: failing-test: property test with arbitrary type strings; ingest throws Fix direction: store with a fallback type and a flag; report it.
- `dq.paid-before-screen`: failing-test: junk fixture suite (lockfile, CI mail, minified bundle) reaches the paid call
- `dq.complete-after-swallow`: failing-test: make the embedding call throw; document ends complete
- `dq.zero-yield-success`: measurement: funnel counts per stage show the filter removing ~100%
- `dq.stacked-thresholds`: measurement: precision vs coverage sweep on labelled candidates
- `dq.learned-text-no-source`: failing-test: seed a lesson contradicting the source; the answer follows the lesson
- `dq.degenerate-output`: failing-test: feed a degenerate stage output fixture; the pipeline still marks the item complete

## Verification steps

Run in this order after the change; each line is a pass criterion.

1. `dq.v.golden` golden set: precision and recall per item plus the minimum, with Wilson intervals, against the baseline _(measure; stats.mjs)_
2. `dq.v.junk` junk and look-alike fixture suite: reject vs admit with reason codes _(test; test runner)_
3. `dq.v.faults` fault injection on every external call (throw, timeout, 404, empty body) _(test; test doubles)_
4. `dq.v.reconcile` reconciliation SQL: inconsistent complete rows = 0 _(measure; SQL)_
5. `dq.v.funnel` funnel log per automated job in shadow mode, then apply mode _(measure; job logs)_
6. `dq.v.tasks` task scripts on the old build vs the new one, then an axe scan _(render; Playwright + axe)_

## Triggers

Loaded by `tools/unslop/classify.mjs` when the task says "ingest", "ingestion", "pipeline", "etl", "extract", "extraction", "embed", "embedding", "upload", "import", "connector", "sync", or touches `**/ingest*/**`, `**/pipeline*/**`, `**/etl/**`, `**/extract*/**`, `**/import*/**`, `**/connectors/**`, `**/embed*`, `**/upload*/**`.

<!-- checks:end -->

## Tools and how to read them

| tool | how to run it | what number to read | valid only when | trap |
|---|---|---|---|---|
| stage postconditions | per stage: items in = items out + items failed (with reasons) | the equation holds; failures counted | run on a real batch | "complete" status with failed embeddings |
| golden set | a fixed sample of real inputs with expected output | precision and recall per stage vs the last run | held out from tuning | judging on synthetic inputs only |
| yield alert | output per input over time | drop beyond the normal band raises an alert | per source | silent zero-output runs |
| content screen | rules for spam, lockfiles, generated files, error pages | rejects counted with reasons | before any paid call | paying to process junk |

## Known traps

| symptom | measure | cause | fix |
|---|---|---|---|
| One odd file kills the batch | feed an unknown type | throw on unknown type | keep as unknown, count it, continue |
| Error page indexed as content | fetch a 404 in a test | HTTP status never checked | check status before parsing |
| Nightly job does nothing | count of applied changes per run | over-conservative thresholds | measure thresholds on a golden set |

## Sources

Dated sources with their verification tags are in [SOURCES.md](SOURCES.md). Claims tagged unverified there are not stated as fact here.
