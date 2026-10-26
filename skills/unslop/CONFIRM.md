# Confirm briefs: prosecutor and skeptic

Two different agents per candidate. The prosecutor builds the evidence blind; the skeptic reruns it and tries to knock it down. Neither sees the finder's reasoning.

---

## Prosecutor

You get one candidate: `<finding id>`, `<path>:<line>` (`<symbol>`), the claimed failure class `<failureClass>` from pack `eng-<domain>`, and the pack's confirm recipe for rule `<rule id>`. You do NOT get why someone thought it was a bug.

Your job: produce evidence of one kind from `EVIDENCE.md` that shows the harm from a real entry point, inside `<timebox>` minutes.

1. Read the code at the location and its callers (`git grep -n <symbol>`).
2. Write the smallest test, measurement or repro that would fail if the claimed harm is real. Put tests where the project keeps them; put scratch scripts under `<run>/scratch/`.
3. Run it through the recorder, so the commit, environment and output are captured:
   `node {{JSTACK_TOOLS}}/unslop/evidence.mjs run <run> --id <finding>.<kind> --kind <kind> --by prosecutor#<n> -- <command>`
   For a measurement add `--budget <n> --value-regex "<regex with one capture group>"` and run it on the built artifact with `mem_guard` passed first.
4. Report one line: the evidence id, exit code, the assertion or the measured value vs budget. If you could not build evidence in time, say why in one line ("needs a device", "needs production data", "not reachable from any entry point I found"). That becomes UNPROVEN, which is a fine outcome.

Never edit the code under test to make it fail. Never assert on a mock's own behaviour. A test that fails on import or setup is not evidence.

---

## Skeptic

You get the candidate and the evidence id `<id>`. Your job is to find the reason this is NOT a bug, and to check the evidence is real.

1. Rerun it: `node {{JSTACK_TOOLS}}/unslop/evidence.mjs rerun <run> --id <id> --by skeptic#<n>`. It must reproduce (same assertion, or the measurement still over budget and beyond the A/A noise).
2. Read the log: does it fail for the stated reason (the assertion names the defect), not a setup error, a timeout, a missing env var or a flaky dependency?
3. Is the scenario reachable from a real entry point (route, job, UI action), with realistic input?
4. Look for a disqualifier: intentional and documented (`decision` memory entry, a comment naming why), guarded upstream (`path:line`), dead code, covered by a waiver, or a known false positive of this rule.

Verdict, one of:
- `CONFIRMED`: reran and reproduced, no disqualifier. `node {{JSTACK_TOOLS}}/unslop/ledger.mjs move <run> <finding> CONFIRMED --by skeptic#<n> --reason "<one line>" --evidence evidence/<id>.evidence.json`
- `DISMISSED`: a disqualifier with a pointer. `--reason "<path:line or memory id>: <why>"`. Also append `{"rule":"<rule>","verdict":"rejected:<why>","at":"<iso>"}` to `.jstack/local/feedback.jsonl`.
- `UNPROVEN`: the evidence did not reproduce or proves something else. `--reason "<why>"`.

When the pipeline's rejected-finding rate is above its target (see SELF-EVAL.md), two skeptics must agree before CONFIRMED.

---

## Prompt-cache findings (eng-llm-cost `cost.cache-*`, `cost.unstable-prefix`, `cost.volatile-system-prompt`, `cost.compaction-churn` ...)

Reading the code never confirms a cache finding: the provider's usage numbers do. Two ways, cheapest first.

1. **Existing usage records** (free). Export the call site's rows (one JSON object per line with `site`, `at` and the provider usage: `input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `cache_creation.ephemeral_1h_input_tokens`, or the OpenAI / OpenTelemetry equivalents), then:
   `node {{JSTACK_TOOLS}}/unslop/evidence.mjs run <run> --id <finding>.measurement --kind measurement --by prosecutor#<n> --budget <100 - hot-loop hit target> --value-regex "miss_pct=([\d.]+)" -- node {{JSTACK_TOOLS}}/unslop/cache-probe.mjs usage <rows.jsonl> --by site`
   The verdict per site is `write-only` (reads per write under the break-even: the cache costs more than none), `not-cached`, `below-target` or `ok`; `gaps_over_ttl_pct` answers a TTL claim.
2. **Replay** (paid: estimate first, smallest model the site uses). Send the exact request of the flagged site twice, sequentially, within the TTL, through the project's metered client; save both responses' JSON under `<run>/scratch/`. For a varying-prefix claim, send two requests that differ only in the per-task part (two tasks, users or times). Then:
   `node {{JSTACK_TOOLS}}/unslop/evidence.mjs run <run> --id <finding>.repro-script --kind repro-script --by prosecutor#<n> -- node {{JSTACK_TOOLS}}/unslop/cache-probe.mjs replay <run>/scratch/a.json <run>/scratch/b.json`
   Exit 1 with `verdict=write-only`, `not-cached` or `prefix-moved` is the evidence; `ok` dismisses the candidate.

The skeptic reruns the probe on the same saved files (`evidence.mjs rerun`), and for a replay sends the pair once more itself: the finding counts only when its own pair gives the same verdict. Before CONFIRMED, check the disqualifiers that fake a miss: the two calls ran in parallel (an entry is readable only after the first response starts), the gap exceeded the TTL, the model or tool list changed between them, or the prefix is under the model's minimum cacheable length (that is its own finding, `cost.under-min-cache-length`, not a layout bug).

## Prompt-quality findings (eng-llm-prompting `prompt.*`) and batch findings (`cost.batchable-sync-job`, `cost.batch-*`)

- **A layout or reorder finding** (`prompt.question-before-docs`, `prompt.reorder-without-ab`, `prompt.shuffled-examples`) is confirmed by scores, not by reading: score the held-out cases on both prompts with the same model, parameters and grader into `before.jsonl` / `after.jsonl` (`{"case", "score"}` per line), then
  `node {{JSTACK_TOOLS}}/unslop/evidence.mjs run <run> --id <finding>.measurement --kind measurement --by prosecutor#<n> -- node {{JSTACK_TOOLS}}/unslop/prompt-ab.mjs compare before.jsonl after.jsonl --max-drop-pp <budget> --min-n <budget>`.
  `verdict=regressed` is the evidence for a reorder that hurt quality; for `prompt.question-before-docs` the arms are the current order and the documents-first order, and `better=true` on the second confirms it. The skeptic reruns on the same score files and checks that both arms ran the same cases (`mismatched` otherwise) and that the cases were not used to write the prompt.
- **A judge finding** (`prompt.judge-uncalibrated`): `prompt-ab.mjs judge human.jsonl judge.jsonl --min-agreement <budget>`; `uncalibrated` is the evidence. Read `kappa` and `majority_share` too: a judge that always gives the majority label can pass on agreement alone.
- **A prefill finding** (`prompt.prefill-last-turn`): a failing test that sends the request to a current model (or replays a recorded 400 "prefill not supported").
- **A batch finding**: static proof that nobody waits (the scheduler entry, no caller awaiting the result) plus the site's metered spend from usage records; the saving claimed is that spend x 0.5. Dismiss it when a person waits on the result or the steps chain (`cost.batch-on-interactive` is the opposite finding).
