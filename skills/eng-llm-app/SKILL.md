---
name: eng-llm-app
description: "Use when a change touches a product agent loop, prompts, tools given to a model, classifiers, compaction, consent and approval flows, or model output shown to users. Fix the root cause in the loop, give the model whole data, prove with live turns."
---

# Product agent loops and LLM features: think before, prove after

Start with the simplest loop that works and add a layer only when an A/B shows it earns its cost. Most agent failures were patched with guards, judges and retries around the loop instead of fixing the root cause: a tool that returns too little, a cap that hides the rest, a classifier answering an open question, a prompt that carries one user's case. Tools return whole data or a page with how much is left, outcomes are typed, and claims match receipts.

## How this pack is used

- **Before** (`/preflight`): answer the questions for the task's tier (S: MUST, M: + SHOULD, L: all + a pre-mortem). An answer that needs a number gets a number or "unknown, measure first". Copy the budgets that apply into the pre-flight with how each is measured.
- **After** (`/unslop`): the static red flags run in `tools/unslop/scan.mjs`; the review agent reads the diff for the `eyes` ones. A red flag is a hypothesis until a confirm recipe produces evidence that a second agent reproduces.
- **Machine part**: `checks.json` in this folder (triggers, questions, budgets, rules, verify). Projects tune it in `.jstack/unslop.json` (rule modes, waivers, extra questions and rules).

<!-- checks:begin (generated from checks.json by tools/unslop/packs.mjs; edit checks.json, then render) -->

## Pre-flight questions

**MUST (asked at every tier)**

- `llm.q.root-cause` What is the root cause (5 whys)? Can the loop fix it with a tool or a context fact instead of a new guard, judge, retry or wait layer? _(answer as: text; prevents: layer-creep)_
- `llm.q.what-is-cut` Does any output get cut? Where does the agent learn what is left and how to get it? _(answer as: text; prevents: silent-truncation)_

**SHOULD (tier M and L)**

- `llm.q.closed-decision` Is any decision I am adding closed (finite labels and a fallback)? If not, the agent decides, not a classifier. _(answer as: table; prevents: classifier-overuse)_
- `llm.q.derived-budgets` Is every numeric budget (tokens, turns, caps) derived from the current model or resource, with a measurement behind it? _(answer as: text; prevents: stale-constants)_
- `llm.q.effect-matrix` For each action: requested? reversible? outward? sensitive? Does it ask only when needed, with undo otherwise? _(answer as: table; prevents: consent-fatigue)_
- `llm.q.receipts` Can the agent verify its own result and act later through a mechanism with an id, not a promise? _(answer as: text; prevents: claims-without-receipts)_
- `llm.q.capability` Can the agent do, through its tools, everything the user can do by hand for this feature (connect, install, re-check, reschedule, fall back when a source fails)? Does each tool's description say when to use it? _(answer as: table; prevents: missing-capability, narrow-tool)_
- `llm.q.output-shape` Which output-shape metrics must hold (length, rich-format rate, language, tool use), and are they re-measured on a replay set after any model, provider or prompt change? _(answer as: table; prevents: format-regression)_

**DEEP (tier L, with the pre-mortem)**

- `llm.q.trifecta` Which inputs are untrusted? Does any context hold private data, untrusted content and an external send together? _(answer as: table; prevents: prompt-injection)_
- `llm.q.bursts` Who uses the budget, how is it shared, and what happens with a burst of 10 messages? _(answer as: text; prevents: budget-hog)_
- `llm.q.held-out` Which held-out cases will show this generalises, and which metric and effect size decide it? Would every line make sense for a user in another industry and language? _(answer as: text; prevents: case-specific-fix)_

## Budgets

Defaults with their source. The project file `.jstack/budgets.json` wins; `null` means the project sets it the first time a task touches it (pre-flight turns that into a measure-first task).

| key | default | unit | how measured | source |
|---|---|---|---|---|
| `llm.model_calls_per_turn` | null | count | model calls per turn on a fixed replay set, before and after | Anthropic, Building effective agents (2024) |
| `llm.trivial_turn_p95_s` | null | s | golden set of trivial prompts: zero tool calls, p95 latency | Nielsen response-time limits |
| `llm.claims_without_receipt` | 0 | count | trace scan: completion/commitment phrases without a tool call or job id | Chain-of-Verification (ACL 2024) |

## Red flags

A red flag is a hypothesis. /unslop turns it into a finding only with evidence (see Confirm recipes).

| id | what it looks like | why it is slop | detector | severity |
|---|---|---|---|---|
| `llm.silent-slice` | List cut with .slice(0, N) in a file that never reports what is left | The agent never learns item N+1 exists and answers from a partial list. | static `llm.silent-slice` (regex) | low |
| `llm.token-threshold-literal` | Compaction/context threshold written as a literal token count | A number tuned for an older, smaller model compacts far too early on today's window. | static `llm.token-threshold-literal` (regex) | medium |
| `llm.layer-around-loop` | New judge/guard/verify/retry/wait wrapper around the main loop with no ablation | Each layer adds latency and cost and hides the root cause. | review agent (eyes) | medium |
| `llm.classifier-open-decision` | Classifier output feeding a free-text slot, or a threshold with no calibration data | Open decisions squeezed into labels fail on everything outside them. | review agent (eyes) | medium |
| `llm.untrusted-in-instructions` | Untrusted content (web, mail, documents, tool output) concatenated into the instruction slot | Planted text becomes an instruction. | review agent (eyes) | high |
| `llm.promise-without-mechanism` | Reply says done or 'I will ...' with no tool call or scheduled job in the trace | The user trusts a promise nothing will keep. | review agent (eyes) | high |
| `llm.case-words-in-prompt` | Proper nouns or quoted phrases from one user's case inside a generic prompt | Passes the visible case, fails everyone else. | review agent (eyes) | medium |
| `llm.narrow-tool` | New tool exposes less than the system under it (fixed formats, hardcoded options, no retry or re-check) | The agent cannot do what the user asks even though the system can, so it improvises or asks the user. | review agent (eyes) | medium |
| `llm.model-swap-no-replay` | Model, provider or prompt changed with no replay of the regression set | Output shape (format, length, tool use) silently regresses on the new model. | review agent (eyes) | medium |
| `llm.empty-completion` | Model reply used without checking for empty content or the stop reason; a canned fallback stored as the answer | Provider quirks (empty text after tools or thinking) become stored apologies or blank answers. | review agent (eyes) | high |
| `llm.parallel-agents-same-snapshot` | Several agents answer the same message in parallel from the same snapshot, none seeing the others' replies | They say the same thing in the same shape, or contradict each other, and nobody can build on what was already said. | review agent (eyes) | medium |

## Confirm recipes

- `llm.silent-slice`: failing-test: input above the cap; output is neither complete nor {returned, total, nextCursor} Fix direction: page with a cursor and say how much is left.
- `llm.token-threshold-literal`: measurement: long replays at two thresholds; success and compactions per session Fix direction: a measured fraction of the model's context window read at runtime.
- `llm.layer-around-loop`: measurement: replay with and without the layer; no win beyond A/A noise
- `llm.classifier-open-decision`: measurement: golden set accuracy and calibration report
- `llm.untrusted-in-instructions`: failing-test: canary instruction in a document triggers a tool call
- `llm.promise-without-mechanism`: failing-test: scheduler tool removed; the reply still promises
- `llm.case-words-in-prompt`: measurement: n-gram overlap between fixtures and the prompt; held-out delta
- `llm.narrow-tool`: repro-script: a request the underlying API supports that the tool cannot express
- `llm.model-swap-no-replay`: measurement: replay set on the old and the new model; a tracked output metric drops beyond the A/A noise
- `llm.empty-completion`: failing-test: the provider mock returns empty content; the stored reply is empty or a canned sentence instead of a retry or a visible error
- `llm.parallel-agents-same-snapshot`: repro-script: send one message to a group of N agents and diff the replies; near-identical openings or overlapping content, and no reply references another Fix direction: one agent at a time, each reading the thread including replies already sent, with a per-message reply budget as the loop backstop; let each agent decide to stay silent.

## Verification steps

Run in this order after the change; each line is a pass criterion.

1. `llm.v.replay` the original failing case fails on the base commit and passes on the change _(test; replay harness)_
2. `llm.v.held-out` regression and held-out sets: delta with an effect size and interval, not one run _(measure; stats.mjs)_
3. `llm.v.ablation` remove each new layer or limit and re-run; keep it only if removal hurts _(measure; A/B replay)_
4. `llm.v.properties` property tests: completeness or pagination; effect matrix -> ask/do; untrusted never an instruction _(test; fast-check / Hypothesis)_
5. `llm.v.claims` claim audit on replay traces: every completion or commitment has a receipt _(test; trace scan)_

## Triggers

Loaded by `tools/unslop/classify.mjs` when the task says "agent", "llm", "prompt", "model", "tool", "tools", "judge", "classifier", "classify", "compaction", "context", "approval", or touches `**/agents/**`, `**/agent/**`, `**/prompts/**`, `**/*prompt*`, `**/tools/**`, `**/llm/**`, `**/ai/**`, `**/harness/**`.

<!-- checks:end -->

## Tools and how to read them

| tool | how to run it | what number to read | valid only when | trap |
|---|---|---|---|---|
| live turns + replay | run the real loop on recorded conversations; replay the trace after the change | task success and cost per turn vs the baseline arm | same model, same inputs, interleaved | judging from one hand-picked turn |
| ablation A/B | turn the layer off in one arm | the layer improves success beyond A/A noise | decision rule written first | keeping a guard nobody measured |
| trace check | compare what the agent said it did with the tool results in the trace | no claim without a matching `applied: true` | read the trace, not the reply | a no-op read as success |
| injection probes | untrusted text with instructions inside tool results | no privileged action taken from it | run with the real tool set | only testing the system prompt |

## Known traps

| symptom | measure | cause | fix |
|---|---|---|---|
| Agent answers from a partial list | feed more items than the cap | silent slice | page with a cursor and say how much is left |
| Compaction too early on a big window | log context size at compaction | threshold frozen for a small model | derive from the model window |
| Agent claims it did something it did not | compare claim with trace | prose tool results, no typed outcome | typed outcome; reply from receipts |

## Sources

Dated sources with their verification tags are in [SOURCES.md](SOURCES.md). Claims tagged unverified there are not stated as fact here.
