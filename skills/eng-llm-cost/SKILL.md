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
- `cost.q.cache-layout` For each cached call: where is each breakpoint, and what in it or before it changes per call or per task (time, ids, place, ranked or retrieved text, the tool list)? Does the varying part sit after the breakpoint as its own block or message? Is it request-level (automatic) cache_control, and is the last block unique per call? _(answer as: text; prevents: cache-miss, cache-write-only)_
- `cost.q.cache-reuse` Who reads this prefix back, and how soon: calls sharing it within the TTL (measured gaps), its size against the model's minimum cacheable length, the TTL chosen (5 min or 1 h), and does metering record 1-hour writes as their own unit? _(answer as: table; prevents: cache-write-only, cache-ttl-mismatch)_

**DEEP (tier L, with the pre-mortem)**

- `cost.q.cache-prefix` Is the prompt prefix stable and over the model's minimum cacheable length? Where is the breakpoint, and what changes before it? _(answer as: text; prevents: cache-miss)_
- `cost.q.limits-source` Where do limits come from at decision time (source of truth or a cache), and how stale can they be? _(answer as: text; prevents: stale-limits)_
- `cost.q.experiments` For experiments: sample size from a power analysis, cost estimate, budget, stop rule. For keys: ledger state checked before testing? _(answer as: number; prevents: experiment-overspend)_
- `cost.q.compaction-cache` If the loop compacts, clears or windows its history: how many steps per 100 rewrite the cached prefix, does it clear in large chunks (hysteresis: trigger high, clear at least N tokens), and do all windows and limits step on the same turns? _(answer as: number; prevents: cache-churn)_

## Budgets

Defaults with their source. The project file `.jstack/budgets.json` wins; `null` means the project sets it the first time a task touches it (pre-flight turns that into a measure-first task).

| key | default | unit | how measured | source |
|---|---|---|---|---|
| `cost.max_usd_per_trigger` | null | USD | worst-case arithmetic in pre-flight + metered sum per job | OWASP LLM10:2025 Unbounded Consumption |
| `cost.unmetered_call_sites` | 0 | count | bypass scan (cost.direct-sdk) outside the metered client | design by contract: single choke point |
| `cost.metered_vs_invoice_gap_pct` | 2 | % | metered sum vs provider usage export per provider per day | FinOps reconciliation (judgement threshold) |
| `cost.cache_hit_pct_hot_loop_min` | 70 | % | cache_read / (uncached + cache_read + cache_write) per hot call site (agent loop, chat, repeated batch) over 7 days, from usage records (cache-probe.mjs usage) | judgement threshold: loops that read new tool output write it once on any layout; tune from a measured baseline |
| `cost.cache_reads_per_write_min` | 0.3 | ratio | cache_read tokens / cache_write tokens per call site; under break-even the cache costs more than no cache (0.28 for 5-minute writes, 1.11 for 1-hour writes) | Anthropic prompt caching pricing: write 1.25x (5 min) or 2x (1 h), read 0.1x base input |
| `cost.cache_rewrites_per_100_steps` | null | count | loop steps whose cache_write exceeds the step's new content, per 100 steps, in a replay of real long turns | Anthropic context editing: clearing invalidates the cached prefix; clear_at_least makes each invalidation worth it |

## Red flags

A red flag is a hypothesis. /unslop turns it into a finding only with evidence (see Confirm recipes).

| id | what it looks like | why it is slop | detector | severity |
|---|---|---|---|---|
| `cost.direct-sdk` | Provider SDK used directly outside the metered client | Every call here is spend nobody records or bills. | static `cost.direct-sdk` (regex) | high |
| `cost.fail-open-gate` | Quota/spend gate that allows on error (catch returns true/null) | When the quota store is down, every paid call goes through (CWE-636). | static `cost.fail-open-gate` (regex) | high |
| `cost.allow-default` | Gate defaults to allow (?? true / \|\| true) | A missing limit reads as unlimited. | static `cost.allow-default` (regex) | medium |
| `cost.unbounded-fanout` | Per-item paid call in a loop with no size bound or job ceiling before it | A big upload (or a zip bomb) multiplies the bill. | review agent (eyes) | high |
| `cost.unconditional-handler` | Message or webhook handler calls the model on every event | Group chatter becomes paid calls. | review agent (eyes) | medium |
| `cost.unstable-prefix` | Per-call or per-task content (time, ids, place, user name, ranked or retrieved text) in or before the cached prefix; tools in non-deterministic order | Every request misses the prompt cache. | review agent (eyes) | medium |
| `cost.precomputed-credits` | Usage logged as converted credits or dollars instead of raw provider units | Pricing changes cannot be replayed; reconciliation with the invoice breaks. | review agent (eyes) | medium |
| `cost.shared-pool` | One spend or rate pool shared by several agents or users with no per-consumer cap | One busy consumer spends the pool and every other one is refused. | review agent (eyes) | medium |
| `cost.limit-from-session` | Quota or plan limit read from the session, token claims or a long-lived cache at decision time | A raised or lowered limit takes effect only after re-login, so users are blocked or overspend. | review agent (eyes) | medium |
| `cost.cache-top-level` | Request-level (automatic) cache_control on a Messages call | Automatic caching puts the breakpoint on the last block. When that block is unique per call, every call writes the whole prompt at 1.25x or 2x and nothing reads it: more than no cache. | static `cost.cache-top-level` (script cache-top-level) | medium |
| `cost.volatile-system-prompt` | Clock, random value or uuid interpolated into a system prompt | The system prompt renders before the messages, so a value that changes per call breaks the cached prefix of everything after it: every call writes again. | static `cost.volatile-system-prompt` (regex) | medium |
| `cost.tools-from-set` | Tool list built from a set (order not stable across processes) | Tools render first in the cached prefix; string-hash randomisation reorders a set per process, so each worker or restart rewrites the whole cache. | static `cost.tools-from-set` (regex) | medium |
| `cost.cache-write-only` | Breakpoint on content that is unique per call (the last block, a per-call turn, a retry note) | Each call writes its whole prompt at the write premium and no later call reads it. | review agent (eyes) | medium |
| `cost.compaction-churn` | History compaction or tool-result clearing that removes a little on almost every step | Every clear rewrites the cached prefix from the cut, so a loop past its threshold pays a cache write per step. | review agent (eyes) | medium |
| `cost.unsynced-windows` | Two history windows or limits that step on different turns | Each step of either window changes earlier history, so the prefix is rewritten on alternate turns instead of once per cycle. | review agent (eyes) | low |
| `cost.single-call-breakpoint` | Cache breakpoint on single-call work (one call per document, hours apart) | Nothing reads the prefix back within the TTL, so the breakpoint only adds the write premium. | review agent (eyes) | low |
| `cost.under-min-cache-length` | Cached prefix shorter than the model's minimum cacheable length | Below the minimum the request is processed without caching and no error is returned: the breakpoint does nothing. | review agent (eyes) | low |
| `cost.cache-ttl-mismatch` | Cache TTL chosen without measured reuse gaps, or 1-hour writes metered at the 5-minute rate | A 1-hour write costs 2x input against 1.25x: it pays only when enough reads land 5-60 min later, and metering that folds it into 5-minute writes under-bills. | review agent (eyes) | medium |
| `cost.uncached-hot-path` | Hot path (agent or chat loop) on a provider or model that reports ~0 cache reads | A loop resends its growing history every step; with no cache each step pays full input on all of it. | review agent (eyes) | medium |

## Confirm recipes

- `cost.direct-sdk`: failing-test: mock the provider, call the path, assert one usage event per attempt (fails: zero) Fix direction: route through the project's metered client; set metered paths in .jstack/unslop.json extraRules if they differ.
- `cost.fail-open-gate`: failing-test: make the quota store throw; assert the paid call is not made Fix direction: deny on error for paid actions; document any degrade mode.
- `cost.allow-default`: failing-test: limit row absent; assert denied Fix direction: missing means deny (fail-safe default).
- `cost.unbounded-fanout`: failing-test: 10k-entry archive through the entry point with the provider mocked; calls before rejection > N
- `cost.unconditional-handler`: failing-test: replay a chat log; paid calls > messages meeting the trigger
- `cost.unstable-prefix`: measurement: cache-probe.mjs replay of two calls for different tasks or users: verdict write-only or prefix-moved; prompt prefix diff up to the breakpoint Fix direction: split the prompt: the stable part under the breakpoint, the varying part after it as its own block or message.
- `cost.precomputed-credits`: static-proof: the usage event has no input/output token fields
- `cost.shared-pool`: failing-test: consumer A loops until the pool is spent; consumer B is refused
- `cost.limit-from-session`: failing-test: raise the limit in the store; the next request is still refused until re-login
- `cost.cache-top-level`: measurement: cache-probe.mjs replay of the same request twice; verdict write-only (second call cache_read 0, cache_write > 0) Fix direction: block-level breakpoints on what repeats (tools, system, a stable first turn), the per-call part after them unmarked; keep automatic caching only for multi-turn conversations whose last block the next turn reads.
- `cost.volatile-system-prompt`: measurement: cache-probe.mjs replay of two calls a minute apart; verdict write-only or prefix-moved Fix direction: keep the system prompt stable under the breakpoint; send the time, ids or place after it as their own block or in the user turn.
- `cost.tools-from-set`: repro-script: build the tool list in two processes with different PYTHONHASHSEED; the serialised lists differ Fix direction: sort the tools by name (or keep a fixed list) before sending.
- `cost.cache-write-only`: measurement: cache-probe.mjs replay of the same request twice, or cache-probe.mjs usage on the site: reads per write under break-even
- `cost.compaction-churn`: measurement: replay a long real turn through the compactor: rewrites per 100 steps over cost.cache_rewrites_per_100_steps; or usage records: cache_write per step far above the step's new content Fix direction: hysteresis: trigger high and clear down to a much lower target (clear at least N tokens), so clears are rare and each is worth its write.
- `cost.unsynced-windows`: measurement: deterministic replay of stored conversations: share of turns where an earlier message changed Fix direction: derive every window from one step counter so they move on the same turns.
- `cost.single-call-breakpoint`: measurement: cache-probe.mjs usage on the site: cache_read 0 or reads per write under break-even, gaps over the TTL
- `cost.under-min-cache-length`: measurement: token count of the prefix vs the model's documented minimum; usage shows cache_write 0 and cache_read 0 (cache-probe.mjs verdict not-cached)
- `cost.cache-ttl-mismatch`: measurement: cache-probe.mjs usage gaps_over_ttl_pct and reads per write vs break-even per TTL; static-proof: the usage event has no separate 1-hour write field
- `cost.uncached-hot-path`: measurement: cache-probe.mjs usage on the site over a day: hit_pct near 0 with more than one call per session

## Verification steps

Run in this order after the change; each line is a pass criterion.

1. `cost.v.bypass` bypass scan clean (scan.mjs cost.direct-sdk / ESLint no-restricted-imports) _(test; scan.mjs)_
2. `cost.v.attempts` property test: attempts == usage events; keys unique per attempt _(test; fast-check)_
3. `cost.v.fault` quota store down -> paid call refused; bad BYOK key -> system-credit fallback visible and alerted _(test; test doubles)_
4. `cost.v.adversarial-input` zip bomb / 10k-entry archive rejected before the first model call _(test; fixture archive)_
5. `cost.v.cache` cache hit ratio per call site from usage fields; prompt prefix diff across two users _(measure; SQL over usage events)_
6. `cost.v.reconcile` metered sum vs provider usage export per provider per day within budget _(measure; provider usage API)_
7. `cost.v.cache-replay` same request sent twice within the TTL: the second call reads the stable prefix (cache-probe.mjs replay verdict ok); two tasks or users share the prefix up to the breakpoint _(measure; cache-probe.mjs)_
8. `cost.v.cache-sites` per call site from usage records: hit_pct over the hot-loop budget, reads per write over break-even, 1-hour writes metered as their own unit, gaps vs TTL _(measure; cache-probe.mjs usage)_
9. `cost.v.cache-churn` replay of real long turns through the compactor: prefix rewrites per 100 steps within budget, windows step on the same turns _(measure; replay script)_

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
| cache replay | send the same request twice within the TTL, save both responses, `node tools/unslop/cache-probe.mjs replay a.json b.json` | `verdict` (ok, write-only, not-cached, prefix-moved) and `miss_pct` of the second call | the two calls are sequential (a cache entry is readable only after the first response starts) and identical up to the breakpoint | sending them in parallel and reading "write-only" as a layout bug |
| cache by call site | export usage rows (one JSON per line with `site`, `at` and the provider's usage), `cache-probe.mjs usage rows.jsonl --by site` | `hit_pct` vs `cost.cache_hit_pct_hot_loop_min`, `reads_per_write` vs `break_even`, `gaps_over_ttl_pct` | rows carry cache reads and writes as their own fields (and 1-hour writes apart) | a usage store that sums writes into input, so every site looks uncached |

## Prompt-cache layout, in one paragraph

The cache stores the prompt up to a breakpoint, in render order: tools, then system, then messages. Put what repeats (tools in a fixed order, the stable system text, a stable first turn) first and mark the end of it; send whatever changes per call or per task (time, ids, place, ranked or retrieved text, the user's data) after the breakpoint as its own block or message. Request-level automatic caching marks the last block: right for a conversation whose next turn reads it, wrong for one-off calls whose last block is unique. A loop that compacts its history should clear rarely and in big chunks, with every window stepping on the same turns. Single-call work and prompts under the model's minimum gain nothing from a breakpoint. Pick the TTL from measured gaps, and meter 1-hour writes as their own unit.

## Known traps

| symptom | measure | cause | fix |
|---|---|---|---|
| A bill spike from one upload | usage events grouped by trigger | per-chunk model calls, no cap | cap per item; batch; estimate first |
| Gate lets everything through when its store is down | fault-inject the quota store | fail-open catch | fail closed with a typed error |
| Unmetered calls | grep provider SDKs outside the client | direct SDK use | route through the metered client |
| Cache writes every call, reads nothing; costs more than no cache | cache-probe replay: second call `cache_read` 0 | request-level (automatic) breakpoint on a last block unique per call | breakpoints on the stable parts; the per-call part after them, unmarked |
| A loop's hit rate collapses once its history is long | cache writes per step vs the step's new content | compaction clears a little on almost every step | hysteresis: trigger high, clear down far (clear at least N tokens) |
| First turn of every task writes the whole prefix | prefix diff between two tasks | ranked know-how, time or place inside the cached system prompt | split it: stable part under the breakpoint, varying part after |
| Earlier history changes every other turn | replay stored conversations, count changed earlier messages | two windows or limits stepping on different turns | derive both from one step counter |
| Breakpoint set, `cache_write` and `cache_read` both 0 | token count of the prefix | prefix under the model's minimum cacheable length | grow the stable prefix past it or drop the breakpoint |
| 1-hour cache bills low | usage event fields | 1-hour writes metered at the 5-minute rate | record `ephemeral_1h_input_tokens` as its own unit |

## Sources

Dated sources with their verification tags are in [SOURCES.md](SOURCES.md). Claims tagged unverified there are not stated as fact here.
