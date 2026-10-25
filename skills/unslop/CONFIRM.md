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
