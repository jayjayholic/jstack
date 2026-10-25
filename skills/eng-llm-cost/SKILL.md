---
name: eng-llm-cost
description: "Use when a change adds or moves a paid model call, an embedding or OCR or speech call, a trigger that fans out, caching, usage metering, quotas, keys or a benchmark run. Worst-case cost first, metered client only, gates fail closed."
---

# LLM cost, metering, keys and caching: think before, prove after

Every paid call goes through one metered client, records the raw provider quantity, and has a worst-case cost written down before it ships (items x calls per item x price). Spend gates fail closed, triggers have a budget, retries count as real cost, and experiments state their budget before they run.

## How this pack is used

- **Before** (`/preflight`): answer the questions for the task's tier (S: MUST, M: + SHOULD, L: all + a pre-mortem). An answer that needs a number gets a number or "unknown, measure first". Copy the budgets that apply into the pre-flight with how each is measured.
- **After** (`/unslop`): the static red flags run in `tools/unslop/scan.mjs`; the review agent reads the diff for the `eyes` ones. A red flag is a hypothesis until a confirm recipe produces evidence that a second agent reproduces.
- **Machine part**: `checks.json` in this folder (triggers, questions, budgets, rules, verify). Projects tune it in `.jstack/unslop.json` (rule modes, waivers, extra questions and rules).

<!-- checks:begin (generated from checks.json by tools/unslop/packs.mjs; edit checks.json, then render) -->

## Pre-flight questions

**MUST (asked at every tier)**

- `cost.q.choke-point` Through which single client does this paid call go, and does it emit one raw-unit usage event per attempt? _(answer as: text; prevents: unmetered-calls)_
- `cost.q.worst-case` What is the worst-case cost of one trigger with the largest allowed input? Show the arithmetic. _(answer as: number; prevents: runaway-spend)_

**SHOULD (tier M and L)**

- `cost.q.stops` What stops it: per-job ceiling, per-tenant quota, kill switch? What does each do on error? (It must deny.) _(answer as: table; prevents: fail-open-gate)_
- `cost.q.who-pays` Who pays (BYOK, gateway or system key), and how will I see that from the response, not from config? _(answer as: text; prevents: routing-unverified)_
- `cost.q.model-choice` Which model, and which eval shows a cheaper one is not good enough? Can it run batched? _(answer as: text; prevents: expensive-model)_
- `cost.q.trigger` What event triggers the call, and what predicate skips it? Have we computed this result before (cache key, TTL, negative cache)? _(answer as: text; prevents: spend-on-every-event, refetch-known-data)_

**DEEP (tier L, with the pre-mortem)**

- `cost.q.cache-prefix` Is the prompt prefix stable and over the model's minimum cacheable length? Where is the breakpoint, and what changes before it? _(answer as: text; prevents: cache-miss)_
- `cost.q.limits-source` Where do limits come from at decision time (source of truth or a cache), and how stale can they be? _(answer as: text; prevents: stale-limits)_
- `cost.q.experiments` For experiments: sample size from a power analysis, cost estimate, budget, stop rule. For keys: ledger state checked before testing? _(answer as: number; prevents: experiment-overspend)_

## Budgets

Defaults with their source. The project file `.jstack/budgets.json` wins; `null` means the project sets it the first time a task touches it (pre-flight turns that into a measure-first task).

| key | default | unit | how measured | source |
|---|---|---|---|---|
| `cost.max_usd_per_trigger` | null | USD | worst-case arithmetic in pre-flight + metered sum per job | OWASP LLM10:2025 Unbounded Consumption |
| `cost.unmetered_call_sites` | 0 | count | bypass scan (cost.direct-sdk) outside the metered client | design by contract: single choke point |
| `cost.metered_vs_invoice_gap_pct` | 2 | % | metered sum vs provider usage export per provider per day | FinOps reconciliation (judgement threshold) |

## Red flags

A red flag is a hypothesis. /unslop turns it into a finding only with evidence (see Confirm recipes).

| id | what it looks like | why it is slop | detector | severity |
|---|---|---|---|---|
| `cost.direct-sdk` | Provider SDK used directly outside the metered client | Every call here is spend nobody records or bills. | static `cost.direct-sdk` (regex) | high |
| `cost.fail-open-gate` | Quota/spend gate that allows on error (catch returns true/null) | When the quota store is down, every paid call goes through (CWE-636). | static `cost.fail-open-gate` (regex) | high |
| `cost.allow-default` | Gate defaults to allow (?? true / \|\| true) | A missing limit reads as unlimited. | static `cost.allow-default` (regex) | medium |
| `cost.unbounded-fanout` | Per-item paid call in a loop with no size bound or job ceiling before it | A big upload (or a zip bomb) multiplies the bill. | review agent (eyes) | high |
| `cost.unconditional-handler` | Message or webhook handler calls the model on every event | Group chatter becomes paid calls. | review agent (eyes) | medium |
| `cost.unstable-prefix` | Timestamp, id or user name before the cache breakpoint; tools in non-deterministic order | Every request misses the prompt cache. | review agent (eyes) | medium |
| `cost.precomputed-credits` | Usage logged as converted credits or dollars instead of raw provider units | Pricing changes cannot be replayed; reconciliation with the invoice breaks. | review agent (eyes) | medium |

## Confirm recipes

- `cost.direct-sdk`: failing-test: mock the provider, call the path, assert one usage event per attempt (fails: zero) Fix direction: route through the project's metered client; set metered paths in .jstack/unslop.json extraRules if they differ.
- `cost.fail-open-gate`: failing-test: make the quota store throw; assert the paid call is not made Fix direction: deny on error for paid actions; document any degrade mode.
- `cost.allow-default`: failing-test: limit row absent; assert denied Fix direction: missing means deny (fail-safe default).
- `cost.unbounded-fanout`: failing-test: 10k-entry archive through the entry point with the provider mocked; calls before rejection > N
- `cost.unconditional-handler`: failing-test: replay a chat log; paid calls > messages meeting the trigger
- `cost.unstable-prefix`: measurement: cache hit ratio per call site near 0; prompt prefix diff across two users
- `cost.precomputed-credits`: static-proof: the usage event has no input/output token fields

## Verification steps

Run in this order after the change; each line is a pass criterion.

1. `cost.v.bypass` bypass scan clean (scan.mjs cost.direct-sdk / ESLint no-restricted-imports) _(test; scan.mjs)_
2. `cost.v.attempts` property test: attempts == usage events; keys unique per attempt _(test; fast-check)_
3. `cost.v.fault` quota store down -> paid call refused; bad BYOK key -> system-credit fallback visible and alerted _(test; test doubles)_
4. `cost.v.adversarial-input` zip bomb / 10k-entry archive rejected before the first model call _(test; fixture archive)_
5. `cost.v.cache` cache hit ratio per call site from usage fields; prompt prefix diff across two users _(measure; SQL over usage events)_
6. `cost.v.reconcile` metered sum vs provider usage export per provider per day within budget _(measure; provider usage API)_

## Triggers

Loaded by `tools/unslop/classify.mjs` when the task says "cost", "costs", "spend", "billing", "meter", "metering", "usage", "tokens", "quota", "limit", "cache", "caching", or touches `**/ai/**`, `**/llm/**`, `**/*metered*`, `**/*billing*`, `**/*quota*`, `**/*usage*`, `**/*spend*`, `**/*budget*`.

<!-- checks:end -->

## Tools and how to read them

| tool | how to run it | what number to read | valid only when | trap |
|---|---|---|---|---|
| worst-case arithmetic | items x calls/item x tokens x price, in the pre-flight | under `cost.max_usd_per_trigger` | use the largest realistic input | pricing a typical item instead of the worst |
| metering check | `git grep` for SDK imports and raw HTTP calls to providers outside the client | zero direct calls | include scripts and background jobs | a cron job with no user to bill |
| usage reconciliation | sum metered events vs the provider's usage page for a day | within a few percent | same time window and zone | cached calls counted as paid or vice versa |
| kill path | how to stop a runaway job (queue delete, flag) | documented and tested once | works without a deploy | finding out during the incident |

## Known traps

| symptom | measure | cause | fix |
|---|---|---|---|
| A bill spike from one upload | usage events grouped by trigger | per-chunk model calls, no cap | cap per item; batch; estimate first |
| Gate lets everything through when its store is down | fault-inject the quota store | fail-open catch | fail closed with a typed error |
| Unmetered calls | grep provider SDKs outside the client | direct SDK use | route through the metered client |

## Sources

Dated sources with their verification tags are in [SOURCES.md](SOURCES.md). Claims tagged unverified there are not stated as fact here.
