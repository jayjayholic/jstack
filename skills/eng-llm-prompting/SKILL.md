---
name: eng-llm-prompting
description: "Use when a change writes or reorders a prompt, system prompt, few-shot examples, a long-document or RAG prompt, a tool list, a compaction summary, a prefill, or an LLM judge or eval. Lays the prompt out for answer quality and cache together, and proves a change with a held-out A/B."
---

# Prompt quality and layout: one order serves the answer and the cache

The order that answers best is also the order that caches best: stable instructions, tools and examples first, long documents next, the question and anything that varies per call last. A prompt change, including a reorder done for cost, ships only after a before/after comparison on held-out cases, and an LLM judge is trusted only after it agrees with human labels.

## How this pack is used

- **Before** (`/preflight`): answer the questions for the task's tier. Write the request in render order (tools, system, documents, question) with every breakpoint marked, and the held-out cases with their baseline numbers before touching the prompt.
- **After** (`/unslop`): the static red flags run in `tools/unslop/scan.mjs`; the review agent reads the diff for the `eyes` ones. A red flag is a hypothesis until a confirm recipe produces evidence that a second agent reproduces.
- **Suggest**: each finding names the matching tactic below, its gain and its source. A cost finding about the same prompt (breakpoints, TTL, batches) comes from `eng-llm-cost`; load both when a prompt is reordered for cache.
- **Machine part**: `checks.json` in this folder (triggers, questions, budgets, rules, verify, tactics). Projects tune it in `.jstack/unslop.json`.

<!-- checks:begin (generated from checks.json by tools/unslop/packs.mjs; edit checks.json, then render) -->

## Pre-flight questions

**MUST (asked at every tier)**

- `prompt.q.oracle` Which held-out cases (never used while writing the prompt) and which metric decide that this prompt change is better, and what are the baseline numbers before the change? _(answer as: table; prevents: prompt-regression, tuned-on-test)_
- `prompt.q.layout` Write the request in render order: tools, system (role, stable instructions, examples), long documents, then the question and anything that varies per call. Where is each breakpoint, and does anything that changes per call or per user sit before one? _(answer as: text; prevents: cache-miss, question-before-docs)_

**SHOULD (tier M and L)**

- `prompt.q.long-docs` For inputs over ~20k tokens: are the documents above the question and instructions, each in <document> with <source> and <document_content>, and does the prompt ask for the relevant quotes first? _(answer as: text; prevents: question-before-docs)_
- `prompt.q.examples` Are there 3-5 examples that are relevant, diverse and wrapped in <example> tags? Are they one fixed set inside the stable prefix, or picked per call (then after the breakpoint, in a deterministic order)? Do they replace a list of edge-case rules? _(answer as: text; prevents: shuffled-examples, rule-laundry-list)_
- `prompt.q.xml-stable` Are tag names and their order the same on every call, with the varying content only inside tags after the breakpoint? Is any object serialised into the prompt with a stable key order? _(answer as: text; prevents: unstable-structure)_
- `prompt.q.date` Does the model need the date or time? Where does it go (after the last breakpoint), at which granularity (the day, not the millisecond), and in which time zone? _(answer as: text; prevents: cache-miss)_
- `prompt.q.prefill` Does any request end with an assistant turn (prefill)? Which model runs it (prefill is rejected with a 400 from Claude 4.6 on), and what replaces it: structured outputs, a tool with an enum, or a plain instruction? _(answer as: text; prevents: prefill-break)_
- `prompt.q.reorder-ab` If the prompt is reordered or split for caching: which quality A/B runs before and after on the held-out cases (same model, parameters and cases), and which cache numbers (cache-probe.mjs) show the gain? _(answer as: table; prevents: prompt-regression)_
- `prompt.q.tools-scale` How many tools and how many tokens of tool definitions does each request load? At 10+ tools or 10k+ tokens, why not tool search with defer_loading (keeping the 3-5 most used loaded)? _(answer as: number; prevents: tool-bloat)_

**DEEP (tier L, with the pre-mortem)**

- `prompt.q.judge` If an LLM grades the output: is there a written rubric per dimension, one isolated judge per dimension, an 'Unknown' way out, thinking on, and an agreement number against human labels on a labelled sample? Do the cases test both when the behaviour should and should not happen? _(answer as: table; prevents: judge-uncalibrated, one-sided-eval)_
- `prompt.q.compaction` If history is compacted or summarised: was the summary prompt tuned on real long traces (recall first, then precision), are the recent turns kept word for word, and is there a breakpoint at the end of the system prompt so compaction only writes the summary? _(answer as: text; prevents: lossy-compaction)_

## Budgets

Defaults with their source. The project file `.jstack/budgets.json` wins; `null` means the project sets it the first time a task touches it (pre-flight turns that into a measure-first task).

| key | default | unit | how measured | source |
|---|---|---|---|---|
| `prompt.heldout_cases_min` | 50 | count | cases in the held-out set used for the before/after decision (prompt-ab.mjs n) | Anthropic, Define success criteria and build evaluations: a held-out test set, more automated cases over fewer hand-graded ones (the count is a judgement threshold) |
| `prompt.quality_drop_max_pp` | 2 | pp | paired difference after - before on the held-out cases: the lower end of its 95% interval must stay above -2 points (prompt-ab.mjs verdict) | judgement threshold; non-inferiority on a held-out set |
| `prompt.judge_human_agreement_min` | 0.8 | ratio | agreement between the judge and human labels on a labelled sample (prompt-ab.mjs judge: agreement and Cohen's kappa) | Anthropic, Demystifying evals for AI agents: LLM-as-judge graders closely calibrated with human experts (the number is a judgement threshold) |
| `prompt.long_doc_tokens` | 20000 | tokens | count_tokens of the document part; above it, documents go before the question | Anthropic prompting best practices: long context prompting (20k+ tokens), queries at the end up to 30% better |
| `prompt.examples_min` | 3 | count | examples in <example> tags for a format- or tone-sensitive task (3-5) | Anthropic prompting best practices: include 3-5 examples |
| `prompt.tool_defs_defer_tokens` | 10000 | tokens | count_tokens of the tool definitions loaded up front; above it (or at 10+ tools), defer with tool search | Anthropic tool search tool: use it at 10+ tools or 10k+ tokens of definitions |

## Red flags

A red flag is a hypothesis. /unslop turns it into a finding only with evidence (see Confirm recipes).

| id | what it looks like | why it is slop | detector | severity |
|---|---|---|---|---|
| `prompt.question-before-docs` | Question interpolated before the documents in one prompt template | Long documents answer better with the question at the end (up to 30% in Anthropic's tests), and the documents are the part that repeats, so they belong before the varying question for the cache too. | static `prompt.question-before-docs` (regex) | low |
| `prompt.prefill-last-turn` | Request ends with a literal assistant turn (prefill) | From Claude 4.6 on, a prefilled last assistant turn is rejected with a 400; the call works on an old model and breaks on the upgrade. | static `prompt.prefill-last-turn` (regex) | medium |
| `prompt.shuffled-examples` | Few-shot examples shuffled or sampled per call | Examples sit early in the prompt: a new order or subset per call moves the cached prefix, and the output varies with the draw, so a before/after comparison measures noise. | static `prompt.shuffled-examples` (regex) | low |
| `prompt.unstable-structure` | Tag names, section order or serialised key order that change between calls | The model reads a moving layout, and every variant is a new cached prefix. | review agent (eyes) | low |
| `prompt.reorder-without-ab` | Prompt reordered or split for caching with no quality comparison | A layout that caches better can answer worse (an instruction moved away from what it governs, documents moved after the question); the cost win hides a quality loss. | review agent (eyes) | medium |
| `prompt.rule-laundry-list` | A growing list of edge-case rules in the prompt instead of examples | Each case gets a rule, the rules collide, and the prompt gets longer and more brittle; a few canonical examples carry the behaviour better. | review agent (eyes) | low |
| `prompt.judge-uncalibrated` | LLM judge with no agreement number against human labels, or one judge grading every dimension | An uncalibrated judge can reward the wrong thing; every decision taken on its scores inherits the error. | review agent (eyes) | medium |
| `prompt.one-sided-eval` | Eval cases only where the behaviour should happen (or only where it should not) | One-sided cases optimise one side: an agent tested only on when to search learns to search for everything. | review agent (eyes) | medium |
| `prompt.tool-bloat` | Dozens of tools or 10k+ tokens of tool definitions loaded on every request | Tool choice gets worse past 30-50 tools and every request pays for definitions it does not use. | review agent (eyes) | low |
| `prompt.lossy-compaction` | Compaction or summary prompt never tuned on real long traces | Aggressive compaction drops context whose importance shows only later; the agent then repeats work or contradicts itself. | review agent (eyes) | medium |
| `prompt.forced-reply-shape` | Conversational prompt prescribes the shape of every reply (opening line, numbered questions, a guess, a fixed closing) | Every reply comes out in the same skeleton whatever was said, a greeting gets a questionnaire, and the persona and the conversation stop shaping the answer. | review agent (eyes) | medium |

## Confirm recipes

- `prompt.question-before-docs`: measurement: prompt-ab.mjs on held-out cases with the documents moved above the question; plus cache-probe.mjs replay of two questions on the same documents Fix direction: documents first in <documents><document index><source><document_content>, then the instructions and the question. Suggest: `prompt.t.docs-first-question-last`.
- `prompt.prefill-last-turn`: failing-test: send the request to a current model (or a recorded 400) and assert it fails; static-proof: the assistant literal is the last message Fix direction: structured outputs or a tool with an enum for formats and labels; an instruction for preambles. Suggest: `prompt.t.no-prefill`.
- `prompt.shuffled-examples`: measurement: cache-probe.mjs replay of the same input twice (prefix-moved); prompt-ab.mjs of the same prompt against itself across seeds shows the spread Fix direction: one fixed, curated set in the stable prefix; if examples must be picked per input, pick them deterministically and place them after the breakpoint. Suggest: `prompt.t.examples`.
- `prompt.unstable-structure`: measurement: render the prompt for two inputs and diff up to the breakpoint; cache-probe.mjs replay verdict prefix-moved Suggest: `prompt.t.stable-xml`.
- `prompt.reorder-without-ab`: measurement: prompt-ab.mjs on held-out cases before vs after the reorder; verdict regressed Suggest: `prompt.t.ab-before-after`.
- `prompt.rule-laundry-list`: measurement: prompt-ab.mjs with the rule list replaced by 3-5 canonical examples Suggest: `prompt.t.canonical-examples`.
- `prompt.judge-uncalibrated`: measurement: prompt-ab.mjs judge on a labelled sample: agreement under prompt.judge_human_agreement_min Suggest: `prompt.t.judge-calibration`.
- `prompt.one-sided-eval`: static-proof: the case list has no negative (or no positive) cases for the behaviour Suggest: `prompt.t.balanced-cases`.
- `prompt.tool-bloat`: measurement: count_tokens of the tools array; tool-selection accuracy on held-out cases with and without tool search Suggest: `prompt.t.tool-search`.
- `prompt.lossy-compaction`: measurement: replay long real traces through the compactor and check that later turns still find each fact they used (recall of facts used after the cut) Suggest: `prompt.t.compaction-recall-first`.
- `prompt.forced-reply-shape`: measurement: sample 30+ recent real replies and count how many share the same skeleton; quote the prompt lines (base, persona, know-how, first-contact, examples) that prescribe it Fix direction: remove the format orders and keep facts, goals and capabilities; if a format matters for one case, show 3-5 diverse examples instead of a template. Suggest: `prompt.t.examples`.

## Tactics to suggest

A finding or a pre-flight answer that matches the "when" names the tactic, its saving and its source. Suggest, never apply silently: the tactic still goes through the verify steps.

| id | tactic | when | saving | source |
|---|---|---|---|---|
| `prompt.t.docs-first-question-last` | Long documents at the top in <documents><document index="n"><source>...<document_content>, instructions and the question after them | inputs over ~20k tokens, or any repeated document asked several questions | up to 30% better answers in Anthropic's tests, and the documents become a cacheable prefix | https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices |
| `prompt.t.quote-first` | Ask for the relevant quotes first (in <quotes>), then the answer from them | long-document tasks where the answer depends on a few passages | focus on the relevant content; the quotes make the answer checkable | https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices |
| `prompt.t.examples` | 3-5 relevant, diverse examples in <example> tags (several inside <examples>), one fixed set in the stable prefix | output format, tone or structure matters | more accurate and consistent output; a fixed set stays cached | https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices |
| `prompt.t.canonical-examples` | Replace the edge-case rule list with a few diverse, canonical examples | the prompt grows one rule per bug | a shorter, less brittle prompt | https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents |
| `prompt.t.stable-xml` | Consistent, descriptive tag names in the same order on every call; varying content only inside tags after the breakpoint; nested tags for hierarchy; stable key order when serialising | a prompt assembled from parts | unambiguous parsing and one cached prefix | https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices |
| `prompt.t.context-why` | Say why an instruction matters instead of shouting it (NEVER, ALL CAPS) | rules the model keeps breaking | the model generalises from the reason | https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices |
| `prompt.t.no-prefill` | Replace a last-turn prefill with structured outputs, a tool with an enum for labels, or a plain instruction for preambles | a request ending with an assistant turn | keeps working on Claude 4.6 and later, which return 400 on prefill | https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices |
| `prompt.t.tool-search` | Tool search with defer_loading: true on rarely used tools, the 3-5 most used kept loaded, a breakpoint on a non-deferred tool | 10+ tools, 10k+ tokens of definitions, or several MCP servers | over 85% fewer definition tokens in Anthropic's example; selection accuracy holds past 30-50 tools; the cached prefix is untouched when tools load | https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool |
| `prompt.t.compaction-recall-first` | Tune the compaction prompt on real long traces: maximise recall first, then cut superfluous content; keep recent turns word for word; prefer server-side compaction | a loop or chat that summarises its history | long tasks keep their facts after the cut | https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents |
| `prompt.t.ab-before-after` | Before and after any prompt change or reorder: same held-out cases, model and parameters; paired comparison with an interval; ship only when it excludes a drop larger than the budget, then confirm the cache gain with cache-probe | any prompt change, especially a reorder for caching | no silent quality regression bought with a cost win | https://platform.claude.com/docs/en/test-and-evaluate/develop-tests |
| `prompt.t.judge-calibration` | Judge with a written rubric per dimension, one isolated judge per dimension, an 'Unknown' way out and thinking on; measure agreement with human labels before trusting it | an LLM grades outputs | decisions taken on scores that match expert judgement | https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents |
| `prompt.t.balanced-cases` | Test both the cases where the behaviour should happen and where it should not | an eval for a behaviour (search, tool call, refusal, asking back) | no one-sided optimisation | https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents |
| `prompt.t.smallest-context` | Load the smallest set of high-signal tokens: identifiers and just-in-time retrieval through tools instead of everything up front | a context that grows with retrieved or tool output | accuracy and recall degrade as context grows (context rot) | https://platform.claude.com/docs/en/build-with-claude/context-windows |

## Verification steps

Run in this order after the change; each line is a pass criterion.

1. `prompt.v.heldout-ab` before/after on the held-out cases with the same model, parameters and cases: prompt-ab.mjs verdict ok (n >= prompt.heldout_cases_min, lower bound of the paired difference above -prompt.quality_drop_max_pp) _(measure; prompt-ab.mjs)_
2. `prompt.v.cache-after-reorder` after a reorder for cache: cache-probe.mjs replay verdict ok on two different inputs sharing the prefix, and cache-probe.mjs usage hit_pct up on the site _(measure; cache-probe.mjs)_
3. `prompt.v.judge` judge calibration: agreement and kappa against human labels on a labelled sample, at or above prompt.judge_human_agreement_min, before its scores decide anything _(measure; prompt-ab.mjs judge)_
4. `prompt.v.render-diff` render the prompt for two different inputs: identical bytes up to the last breakpoint (tags, order, examples, keys) _(test; unit test on the prompt builder)_
5. `prompt.v.static` scan clean for prompt.question-before-docs, prompt.prefill-last-turn, prompt.shuffled-examples on the diff _(test; scan.mjs --domain llm-prompting)_

## Triggers

Loaded by `tools/unslop/classify.mjs` when the task says "prompt", "prompts", "prompting", "system prompt", "few-shot", "examples", "xml", "reorder", "layout", "long context", "documents", "rag", or touches `**/prompts/**`, `**/prompt/**`, `**/*prompt*`, `**/*instructions*`, `**/*few-shot*`, `**/*fewshot*`, `**/*examples*`, `**/evals/**`.

<!-- checks:end -->

## The layout, in render order

| position | what goes there | why (quality) | why (cache) |
|---|---|---|---|
| 1. tools | fixed list in a fixed order; rarely used tools deferred with tool search | selection degrades past 30-50 tools | tools render first; a change invalidates everything after |
| 2. system | role, stable instructions with their reasons, 3-5 canonical examples in `<example>` tags; breakpoint at its end | clear, direct instructions and examples steer format and tone | stays cached across turns and across compaction |
| 3. documents | long inputs in `<documents><document index><source><document_content>`; breakpoint after them when several questions reuse them | documents before the question: up to 30% better on long inputs | the repeated part sits before the varying part |
| 4. history | earlier turns; breakpoint moves to the last block each turn (second one if a turn adds 20+ blocks) | full context | each turn reads the previous ones |
| 5. varying part | date at the granularity needed, user or task data, retrieved snippets, the question, "quote the relevant parts first" | the question last, next to the answer | nothing after it needs caching |

Request parameters are part of the prompt too: `tool_choice`, `disable_parallel_tool_use`, the thinking mode, budget and effort are rendered in, so keep them fixed per conversation. A last-turn prefill is rejected from Claude 4.6 on: use structured outputs, a tool with an enum, or an instruction.

## Tools and how to read them

| tool | how to run it | what number to read | valid only when | trap |
|---|---|---|---|---|
| quality A/B | score both arms on the same held-out cases into `before.jsonl` / `after.jsonl` (`{"case": id, "score": 0..1}` per line), then `node tools/unslop/prompt-ab.mjs compare before.jsonl after.jsonl --max-drop-pp 2 --min-n 50` | `verdict` (ok, regressed, too-few), `diff_pp` and its 95% interval `[lo, hi]` | same model, parameters, cases and grader on both arms; cases never used while writing the prompt | reading a mean difference without its interval; tuning on the held-out set |
| judge calibration | label a sample by hand (`{"case", "label"}`), run the judge on the same cases, `prompt-ab.mjs judge human.jsonl judge.jsonl --min-agreement 0.8` | `agreement`, `kappa`, the confusion pairs | the sample covers both outcomes (balanced) | agreement on a sample that is 95% one label (read kappa) |
| cache after a reorder | `cache-probe.mjs replay` of two inputs sharing the prefix; `cache-probe.mjs usage` on the site | verdict ok, hit_pct up | requests sent one after the other | a parallel pair reads as write-only |
| render diff | unit test: build the prompt for two inputs, compare bytes up to the last breakpoint | identical | tags, order, examples and key order come from code | a test that compares only the final string length |

## Known traps

| symptom | measure | cause | fix |
|---|---|---|---|
| Cheaper after a cache reorder, worse answers | prompt-ab.mjs before vs after | an instruction moved away from what it governs, or documents moved after the question | keep documents first and the question last; re-run the A/B |
| Answers vary run to run with the same input | prompt-ab.mjs of the prompt against itself | examples shuffled or sampled per call | one fixed set; per-input picks deterministic and after the breakpoint |
| Works in dev, 400 after a model upgrade | the request ends with an assistant turn | prefill | structured outputs, an enum tool, or an instruction |
| Judge scores rise, users complain | agreement with human labels | uncalibrated judge, one judge for every dimension | rubric per dimension, isolated judges, "Unknown" way out, calibrate |
| Agent searches for everything | eval cases by expected behaviour | only positive cases in the eval | add the cases where it should not search |
| Long tasks lose a fact after the summary | replay long traces through the compactor | summary prompt tuned for brevity, not recall | tune on real traces, recall first; keep recent turns verbatim |

## Sources

Dated sources with their verification tags are in [SOURCES.md](SOURCES.md).
