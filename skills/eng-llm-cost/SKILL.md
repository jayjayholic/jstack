---
name: eng-llm-cost
description: "Use when a change adds or moves a paid model call, an embedding or OCR or speech call, a trigger that fans out, a nightly or bulk job, caching, usage metering, quotas, keys or a benchmark run. Worst-case cost first, metered client only, gates fail closed; suggests cache layout, TTL and batch tactics with their sources."
---

# LLM cost, metering, keys and caching: think before, prove after

Every paid call goes through one metered client, records the raw provider quantity, and has a worst-case cost written down before it ships (items x calls per item x price). Spend gates fail closed, triggers have a budget, retries count as real cost, and experiments state their budget before they run.

## How this pack is used

- **Before** (`/preflight`): answer the questions for the task's tier (S: MUST, M: + SHOULD, L: all + a pre-mortem). An answer that needs a number gets a number or "unknown, measure first". Copy the budgets that apply into the pre-flight with how each is measured.
- **After** (`/unslop`): the static red flags run in `tools/unslop/scan.mjs`; the review agent reads the diff for the `eyes` ones. A red flag is a hypothesis until a confirm recipe produces evidence that a second agent reproduces.
- **Suggest**: every finding and every pre-flight answer that matches a row of Tactics to suggest names that tactic, its saving and its source ("use Batches for this nightly job: -50%", "move the date after the breakpoint"). Prompt quality (layout for answers, examples, judges, A/B of a reorder) lives in the sibling pack `eng-llm-prompting`; load both when a prompt is reordered for cache.
- **Machine part**: `checks.json` in this folder (triggers, questions, budgets, rules, verify, tactics). Projects tune it in `.jstack/unslop.json` (rule modes, waivers, extra questions and rules).

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
- `cost.q.batch-fit` Does anyone wait for this result within minutes? If not (nightly or cron job, backfill, re-index, eval run, bulk extraction), why is it not on a batch API (Anthropic Message Batches: -50%, most batches done within 1 h, expired after 24 h, up to 100,000 requests or 256 MB per batch)? If steps chain, how many rounds, and what is the wall time at up to 24 h each? _(answer as: text; prevents: batchable-sync, batch-on-interactive)_
- `cost.q.cache-invalidators` Which request parameters can change between calls of one conversation or job: tool definitions or their order, tool_choice, disable_parallel_tool_use, images present or absent, thinking mode or budget, effort, web search or citations toggles? Each one invalidates the cache from its level on (tools -> system -> messages). _(answer as: table; prevents: cache-miss)_

**DEEP (tier L, with the pre-mortem)**

- `cost.q.cache-prefix` Is the prompt prefix stable and over the model's minimum cacheable length? Where is the breakpoint, and what changes before it? _(answer as: text; prevents: cache-miss)_
- `cost.q.limits-source` Where do limits come from at decision time (source of truth or a cache), and how stale can they be? _(answer as: text; prevents: stale-limits)_
- `cost.q.experiments` For experiments: sample size from a power analysis, cost estimate, budget, stop rule. For keys: ledger state checked before testing? _(answer as: number; prevents: experiment-overspend)_
- `cost.q.compaction-cache` If the loop compacts, clears or windows its history: how many steps per 100 rewrite the cached prefix, does it clear in large chunks (hysteresis: trigger high, clear at least N tokens), and do all windows and limits step on the same turns? _(answer as: number; prevents: cache-churn)_
- `cost.q.ttl-math` For the TTL chosen, show the break-even with measured reuse gaps: a 5-minute write pays over no cache when reads per written token > 0.28, a 1-hour write when > 1.11; 1-hour beats 5-minute once at least one reuse per hour lands after the 5-minute window. _(answer as: number; prevents: cache-ttl-mismatch)_
- `cost.q.parallel-warm` Do parallel calls share a cached prefix? Is the first response awaited before the rest go out (a cache entry is readable only after the first response starts)? For a batch with a shared prefix, is the prefix written first with a 1-hour TTL? _(answer as: text; prevents: cache-write-only)_

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
| `cost.batchable_sync_share_max` | 10 | % | share of model spend from call sites nobody waits on (cron, backfill, eval, bulk) sent as synchronous calls, from usage records grouped by site | Anthropic Message Batches: 50% of standard price for work that does not need an immediate response (the share is a judgement threshold) |
| `cost.ttl_1h_late_reuses_per_hour_min` | 1 | count | per cached prefix: reuses per hour that land 5-60 min after the previous use (cache-probe.mjs usage gaps). For k such reuses 1-hour costs 2 + 0.1k and 5-minute 1.25(k+1) base-input units: 1-hour is cheaper from k = 1 (k > 0.65) | Anthropic prompt caching pricing: write 1.25x (5 min) or 2x (1 h), read 0.1x |

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
| `cost.cache-param-varies` | Cache-invalidating request parameter chosen per call (tool_choice, thinking, budget_tokens, effort, disable_parallel_tool_use set by a conditional) | tool_choice, disable_parallel_tool_use and the thinking configuration (mode, budget, effort) are rendered into the prompt: a change invalidates the messages cache, and on some models the tools and system caches too. A value that flips between calls of one conversation rewrites its history on each flip. | static `cost.cache-param-varies` (regex) | low |
| `cost.batchable-sync-job` | Synchronous model call in a cron, nightly, backfill or eval job with no batch API in the file | Nobody waits on a scheduled or bulk job, yet each synchronous call pays the full price: the same requests on a batch API cost half. | static `cost.batchable-sync-job` (regex) | low |
| `cost.clock-before-breakpoint` | Clock interpolated into a content block that carries the cache breakpoint | The breakpoint sits on a block whose text changes every call, so each call writes a new entry at the write premium and none is ever read. | static `cost.clock-before-breakpoint` (regex) | medium |
| `cost.parallel-cold-cache` | Parallel calls that share a cached prefix sent at once, with nothing written yet | A cache entry is readable only after the first response starts, so N parallel calls each write the prefix: N writes, no reads. | review agent (eyes) | low |
| `cost.batch-cold-prefix` | Batch of requests sharing a long prefix with no breakpoint, or a 5-minute TTL on it | Batch requests run concurrently and in any order, and a batch often takes 5-60 min: a 5-minute entry expires between requests, so most of them pay the prefix in full. | review agent (eyes) | low |
| `cost.batch-on-interactive` | Batch API used where a person waits for the result or where steps chain | A batch can take up to 24 h and returns results only when every request has ended; a waiting user or a five-step chain turns half price into hours of wall time. | review agent (eyes) | medium |
| `cost.history-breakpoint-stale` | Conversation breakpoint fixed on an early turn, or turns that add 20+ blocks with one breakpoint | Each new turn pays its whole history after the fixed breakpoint; when a turn pushes the breakpoint 20 or more blocks past the last write, the lookback misses it and the whole history is written again. | review agent (eyes) | medium |
| `cost.batch-all-or-nothing` | Error while collecting a batch's results discards the items already received and re-runs the whole set | Answered items were billed and metered already; the fallback pays for them again. | review agent (eyes) | medium |

## Confirm recipes

- `cost.direct-sdk`: failing-test: mock the provider, call the path, assert one usage event per attempt (fails: zero) Fix direction: route through the project's metered client; set metered paths in .jstack/unslop.json extraRules if they differ.
- `cost.fail-open-gate`: failing-test: make the quota store throw; assert the paid call is not made Fix direction: deny on error for paid actions; document any degrade mode.
- `cost.allow-default`: failing-test: limit row absent; assert denied Fix direction: missing means deny (fail-safe default).
- `cost.unbounded-fanout`: failing-test: 10k-entry archive through the entry point with the provider mocked; calls before rejection > N
- `cost.unconditional-handler`: failing-test: replay a chat log; paid calls > messages meeting the trigger
- `cost.unstable-prefix`: measurement: cache-probe.mjs replay of two calls for different tasks or users: verdict write-only or prefix-moved; prompt prefix diff up to the breakpoint Fix direction: split the prompt: the stable part under the breakpoint, the varying part after it as its own block or message. Suggest: `cost.t.date-after-breakpoint`.
- `cost.precomputed-credits`: static-proof: the usage event has no input/output token fields
- `cost.shared-pool`: failing-test: consumer A loops until the pool is spent; consumer B is refused
- `cost.limit-from-session`: failing-test: raise the limit in the store; the next request is still refused until re-login
- `cost.cache-top-level`: measurement: cache-probe.mjs replay of the same request twice; verdict write-only (second call cache_read 0, cache_write > 0) Fix direction: block-level breakpoints on what repeats (tools, system, a stable first turn), the per-call part after them unmarked; keep automatic caching only for multi-turn conversations whose last block the next turn reads. Suggest: `cost.t.breakpoint-after-stable`.
- `cost.volatile-system-prompt`: measurement: cache-probe.mjs replay of two calls a minute apart; verdict write-only or prefix-moved Fix direction: keep the system prompt stable under the breakpoint; send the time, ids or place after it as their own block or in the user turn. Suggest: `cost.t.date-after-breakpoint`.
- `cost.tools-from-set`: repro-script: build the tool list in two processes with different PYTHONHASHSEED; the serialised lists differ Fix direction: sort the tools by name (or keep a fixed list) before sending.
- `cost.cache-write-only`: measurement: cache-probe.mjs replay of the same request twice, or cache-probe.mjs usage on the site: reads per write under break-even Suggest: `cost.t.breakpoint-after-stable`.
- `cost.compaction-churn`: measurement: replay a long real turn through the compactor: rewrites per 100 steps over cost.cache_rewrites_per_100_steps; or usage records: cache_write per step far above the step's new content Fix direction: hysteresis: trigger high and clear down to a much lower target (clear at least N tokens), so clears are rare and each is worth its write. Suggest: `cost.t.clear-at-least`.
- `cost.unsynced-windows`: measurement: deterministic replay of stored conversations: share of turns where an earlier message changed Fix direction: derive every window from one step counter so they move on the same turns. Suggest: `cost.t.history-moving-breakpoint`.
- `cost.single-call-breakpoint`: measurement: cache-probe.mjs usage on the site: cache_read 0 or reads per write under break-even, gaps over the TTL
- `cost.under-min-cache-length`: measurement: token count of the prefix vs the model's documented minimum; usage shows cache_write 0 and cache_read 0 (cache-probe.mjs verdict not-cached) Suggest: `cost.t.count-before-marking`.
- `cost.cache-ttl-mismatch`: measurement: cache-probe.mjs usage gaps_over_ttl_pct and reads per write vs break-even per TTL; static-proof: the usage event has no separate 1-hour write field Suggest: `cost.t.ttl-1h`.
- `cost.uncached-hot-path`: measurement: cache-probe.mjs usage on the site over a day: hit_pct near 0 with more than one call per session Suggest: `cost.t.history-moving-breakpoint`.
- `cost.cache-param-varies`: measurement: cache-probe.mjs replay of two consecutive calls of one conversation where the value differs; verdict prefix-moved or write-only Fix direction: keep the value fixed for the conversation; when it must vary, put a breakpoint before the variation point. Suggest: `cost.t.fixed-request-params`.
- `cost.batchable-sync-job`: static-proof: the job's trigger is a schedule or a bulk run and no caller waits on the result (read the scheduler entry); the saving is the site's metered spend x 0.5 Fix direction: submit the items as one batch (custom_id per item, poll or webhook for the end, handle errored and expired results); keep synchronous calls only for steps a person waits on. Suggest: `cost.t.batches`.
- `cost.clock-before-breakpoint`: measurement: cache-probe.mjs replay of the same request a minute apart; verdict write-only Fix direction: move the time out of the marked block: the stable text keeps the breakpoint, the time goes after it (its own block or the user turn), at the granularity the task needs (the day, not the millisecond). Suggest: `cost.t.date-after-breakpoint`.
- `cost.parallel-cold-cache`: measurement: usage records of one fan-out: cache_creation > 0 on more than one call of the same prefix within a second Suggest: `cost.t.warm-then-fan-out`.
- `cost.batch-cold-prefix`: measurement: cache-probe.mjs usage over the batch results: hit_pct low with a prefix over the minimum cacheable length Suggest: `cost.t.batch-plus-cache`.
- `cost.batch-on-interactive`: measurement: end-to-end wall time of the flow on a real batch vs the latency budget of its caller Suggest: `cost.t.sync-when-waiting`.
- `cost.history-breakpoint-stale`: measurement: cache-probe.mjs usage on a long conversation: uncached input grows turn by turn, or a full rewrite after a tool-heavy turn Suggest: `cost.t.history-moving-breakpoint`.
- `cost.batch-all-or-nothing`: failing-test: fail result collection at item k of n; only n-k items may be re-run Fix direction: persist each result as it streams and retry only the missing ones.

## Tactics to suggest

A finding or a pre-flight answer that matches the "when" names the tactic, its saving and its source. Suggest, never apply silently: the tactic still goes through the verify steps.

| id | tactic | when | saving | source |
|---|---|---|---|---|
| `cost.t.breakpoint-after-stable` | One breakpoint on the last block that stays identical across requests; the timestamp and the incoming message go after it | a breakpoint on per-call content, or automatic caching on a unique last block | reads at 0.1x instead of writes at 1.25x on the stable prefix | https://platform.claude.com/docs/en/build-with-claude/prompt-caching |
| `cost.t.date-after-breakpoint` | Move the date or time after the breakpoint (user turn or its own block), at day granularity unless the task needs more | the clock, an id or a place inside the system prompt or a marked block | the system prompt and everything before the date stay cached | https://platform.claude.com/docs/en/build-with-claude/prompt-caching |
| `cost.t.batches` | Use Message Batches for this job: one batch, custom_id per item, poll or webhook, handle errored and expired results | nobody waits for the result within minutes: nightly, cron, backfill, re-index, evals, bulk extraction | -50% on input and output; most batches end within 1 h, at most 24 h; up to 100,000 requests or 256 MB per batch | https://platform.claude.com/docs/en/build-with-claude/batch-processing |
| `cost.t.batch-plus-cache` | Combine Batches with caching: identical cache_control blocks in every request, a 1-hour TTL, and the shared prefix written by one request before the rest are submitted | a batch whose requests share a long prefix (instructions, a document, examples) | discounts stack (a cached read is ~0.05x base input in a batch); hits are best effort, 30-98% reported | https://platform.claude.com/docs/en/build-with-claude/prompt-caching |
| `cost.t.ttl-1h` | Use the 1-hour TTL only where reuses land 5-60 min apart; keep 5 minutes for prefixes used more often than every 5 minutes (refreshed at no charge) | measured gaps between reuses of one prefix | 1-hour (2 + 0.1k) beats 5-minute (1.25(k+1)) from one late reuse per hour; beats no cache above 1.11 reads per write | https://platform.claude.com/docs/en/build-with-claude/prompt-caching |
| `cost.t.warm-then-fan-out` | Send one call, wait for its first response, then fan out the rest that share the prefix | parallel calls (Promise.all, gather, a worker pool) over one shared prefix | N-1 writes become reads (0.1x instead of 1.25x) | https://platform.claude.com/docs/en/build-with-claude/prompt-caching |
| `cost.t.fixed-request-params` | Keep tool_choice, disable_parallel_tool_use, thinking config and effort fixed for a conversation; when one must vary, place a breakpoint before the variation point | a request parameter chosen per call | history stays cached across turns instead of being rewritten on each flip | https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching |
| `cost.t.history-moving-breakpoint` | Multi-turn: breakpoint on the last block of each request (automatic caching, or explicit on the last user turn); add a second breakpoint when a turn can add 20 or more blocks | a growing conversation or agent loop | each turn reads the previous history and writes only the new turn | https://platform.claude.com/docs/en/build-with-claude/prompt-caching |
| `cost.t.clear-at-least` | Clear tool results with hysteresis: trigger high, clear_at_least a large chunk, exclude_tools for results that must stay | context editing or a custom compactor in a loop | one cache rewrite per clear instead of one per step | https://platform.claude.com/docs/en/build-with-claude/context-editing |
| `cost.t.system-breakpoint-compaction` | Breakpoint at the end of the system prompt, apart from the conversation, so compaction writes only the summary | server or client compaction of a long conversation | the system prompt stays cached across each compaction | https://platform.claude.com/docs/en/build-with-claude/compaction-threshold |
| `cost.t.keep-thinking` | Keep thinking blocks (clear_thinking keep: "all") when cache hits matter more than context room; pass them back unchanged | thinking with tool use in long loops | clearing thinking invalidates the cache at the clearing point | https://platform.claude.com/docs/en/build-with-claude/context-editing |
| `cost.t.count-before-marking` | Count the prefix with the free count_tokens endpoint against the model's minimum cacheable length (512 to 4,096 tokens by model) before adding a breakpoint | a short system prompt or tool list marked for caching | no silent no-op breakpoints; the endpoint is free (rate limited) | https://platform.claude.com/docs/en/build-with-claude/token-counting |
| `cost.t.sync-when-waiting` | Keep synchronous calls (cached) where a person waits or steps chain; batch only the independent bulk part | a batch API on an interactive or multi-step flow | minutes instead of up to 24 h per step | https://platform.claude.com/docs/en/build-with-claude/batch-processing |

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
10. `cost.v.batch-sites` every call site nobody waits on is listed with its trigger and is on a batch API, or has a written reason (a reply needed within minutes, chained steps); spend share within cost.batchable_sync_share_max _(measure; usage records by site)_
11. `cost.v.param-stability` two consecutive calls of one conversation: tools, tool_choice, thinking and effort identical, and the serialized request up to the last breakpoint equal (cache-probe.mjs replay verdict ok) _(measure; cache-probe.mjs replay)_
12. `cost.v.batch-cache` a batch with a shared prefix: cache read share over its results (Anthropic reports 30-98% as best effort); prefix written first with a 1-hour TTL _(measure; cache-probe.mjs usage)_

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
| token count | `count_tokens` with the same model, system, tools and messages (free, rate limited; an estimate; no caching) | prefix tokens vs the minimum cacheable length (512 to 4,096 by model) | count with the model you will run (newer tokenizers count ~30% more) | reusing a count from an older model |
| cache by call site | export usage rows (one JSON per line with `site`, `at` and the provider's usage), `cache-probe.mjs usage rows.jsonl --by site` | `hit_pct` vs `cost.cache_hit_pct_hot_loop_min`, `reads_per_write` vs `break_even`, `gaps_over_ttl_pct` | rows carry cache reads and writes as their own fields (and 1-hour writes apart) | a usage store that sums writes into input, so every site looks uncached |

## Break-even arithmetic (base input price = 1)

| choice | cost of a prefix used 1 + k times | pays when | source |
|---|---|---|---|
| 5-minute cache vs none | 1.25 + 0.1k vs 1 + k | k > 0.28 reads per written token | prompt caching pricing |
| 1-hour cache vs none | 2 + 0.1k vs 1 + k | k > 1.11 | prompt caching pricing |
| 1-hour vs 5-minute, k reuses each 5-60 min after the last | 2 + 0.1k vs 1.25(k + 1) | k > 0.65, so from one late reuse per hour | prompt caching pricing |
| Batches vs synchronous | 0.5x on input and output | nobody waits within minutes and steps do not chain | batch processing |
| Batches + cache | multipliers stack: cached read ~0.05x, 5-minute write ~0.625x | the shared prefix is written first (1-hour TTL); hits are best effort, 30-98% reported | prompt caching FAQ, batch processing |

A batch ends within 24 h (most within 1 h), holds up to 100,000 requests or 256 MB, returns results in any order (match by `custom_id`) for 29 days, and does not bill expired requests. It is wrong for a person waiting, for chained steps (each round can take hours), and for cache pre-warming (`max_tokens: 0` is rejected inside a batch).

## Prompt-cache layout, in one paragraph

The cache stores the prompt up to a breakpoint, in render order: tools, then system, then messages. Put what repeats (tools in a fixed order, the stable system text, a stable first turn) first and mark the end of it; send whatever changes per call or per task (time, ids, place, ranked or retrieved text, the user's data) after the breakpoint as its own block or message. Request-level automatic caching marks the last block: right for a conversation whose next turn reads it, wrong for one-off calls whose last block is unique. A loop that compacts its history should clear rarely and in big chunks, with every window stepping on the same turns. Single-call work and prompts under the model's minimum gain nothing from a breakpoint. Pick the TTL from measured gaps, and meter 1-hour writes as their own unit.

## Known traps

| symptom | measure | cause | fix |
|---|---|---|---|
| A nightly job costs as much as daytime chat | usage records by site, trigger = schedule | synchronous calls where nobody waits | Message Batches (-50%) |
| History rewritten on some turns only | replay two turns, diff the request | tool_choice, thinking or effort chosen per call | fix it per conversation, or a breakpoint before the variation point |
| A fan-out of N calls writes the prefix N times | usage rows of one fan-out, same second | parallel calls before any entry exists | await the first response, then fan out |
| A batch with a shared prefix reads little | cache-probe usage over the batch results | 5-minute entries expire across a 5-60 min batch | 1-hour TTL, prefix written by one request first |
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
