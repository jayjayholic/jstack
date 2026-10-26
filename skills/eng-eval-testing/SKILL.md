---
name: eng-eval-testing
description: "Use for every change that claims to work: tests, evals, benchmarks, A/B comparisons, READY claims, LLM judges, flaky tests. The oracle is written before the code and checked by something other than the agent that wrote it."
---

# Evaluation, proof and testing: think before, prove after

When the evidence that work is done is produced and checked by the same agent, "it ran" becomes the oracle. Fix the oracle before writing code (acceptance criteria as runnable checks, a test seen failing first), keep it out of the agent's reach (held-out sets, independent reruns, artifacts with provenance), and check the measurement is valid before trusting it (preconditions, A/A, a baseline arm).

## How this pack is used

- **Before** (`/preflight`): answer the questions for the task's tier (S: MUST, M: + SHOULD, L: all + a pre-mortem). An answer that needs a number gets a number or "unknown, measure first". Copy the budgets that apply into the pre-flight with how each is measured.
- **After** (`/unslop`): the static red flags run in `tools/unslop/scan.mjs`; the review agent reads the diff for the `eyes` ones. A red flag is a hypothesis until a confirm recipe produces evidence that a second agent reproduces.
- **Machine part**: `checks.json` in this folder (triggers, questions, budgets, rules, verify). Projects tune it in `.jstack/unslop.json` (rule modes, waivers, extra questions and rules).

<!-- checks:begin (generated from checks.json by tools/unslop/packs.mjs; edit checks.json, then render) -->

## Pre-flight questions

**MUST (asked at every tier)**

- `test.q.oracle` What is the oracle: which command, test, rubric or labelled set says this is correct, and does it exist before my change? _(answer as: text; prevents: self-certification)_
- `test.q.evidence` What evidence will I attach to done (command, exit code, SHA, log or screenshot with provenance), and could someone else rerun it? _(answer as: text; prevents: done-without-proof)_

**SHOULD (tier M and L)**

- `test.q.dod` What is the Definition of Done, written as runnable checks with thresholds? _(answer as: list; prevents: pass-on-execution)_
- `test.q.repro` Can I reproduce the problem now, on the baseline, with a script I can commit? _(answer as: file; prevents: speculative-fix)_
- `test.q.outward` Which outward or irreversible actions can this code or test perform, and what blocks them by default (egress deny, hold flag, dry-run)? _(answer as: list; prevents: test-side-effects)_
- `test.q.lane` Which shared resources (ports, DB, queues, tenants, branches, deploys) will I touch, and how is my lane isolated and cleaned up? _(answer as: list; prevents: shared-environment)_
- `test.q.old-assertions` Which existing tests assert the behaviour I am changing (grep the old literal, route, label, default, count or shape), and did I run them too, not only the tests next to the files I touched? _(answer as: list; prevents: stale-test)_

**DEEP (tier L, with the pre-mortem)**

- `test.q.baseline` Which baseline arm do I compare against (clean HEAD worktree, frozen numbers), and is the A/A difference about zero? _(answer as: number; prevents: no-baseline)_
- `test.q.validity` What are the validity preconditions (RAM/CPU floors, headed GPU, production build, isolated lane), and does a preflight enforce them? _(answer as: list; prevents: invalid-measurement)_
- `test.q.feedback-loop` How long is my inner feedback loop, and what fixture or snapshot would cut it below a minute? _(answer as: number; prevents: slow-feedback)_
- `test.q.judge` If I use an LLM judge: what is its measured agreement with humans, and is it order-swapped and blind? _(answer as: number; prevents: uncalibrated-judge)_

## Budgets

Defaults with their source. The project file `.jstack/budgets.json` wins; `null` means the project sets it the first time a task touches it (pre-flight turns that into a measure-first task).

| key | default | unit | how measured | source |
|---|---|---|---|---|
| `tests.inner_loop_s` | 60 | s | wall time of the targeted test command | Humble & Farley, Continuous Delivery (2010) |
| `tests.flaky_reruns` | 5 | runs | shuffled, repeated runs of the affected suites must all pass | Luo et al., FSE 2014 |
| `tests.judge_agreement_kappa` | null | kappa | Cohen's kappa vs >= 30 human labels before trusting a judge | Zheng et al., NeurIPS 2023 |

## Red flags

A red flag is a hypothesis. /unslop turns it into a finding only with evidence (see Confirm recipes).

| id | what it looks like | why it is slop | detector | severity |
|---|---|---|---|---|
| `test.focus-skip` | Focused or skipped test (.only, .skip, xit, @skip) | The suite goes green by not running the tests that matter. | static `test.focus-skip` (regex) | high |
| `test.sleep-wait` | Fixed sleep used to wait in a test | Too short on a busy machine, too long everywhere else. | static `test.sleep-wait` (regex) | medium |
| `test.weak-assert` | Weak assertion (toBeTruthy/toBeDefined/not.toBeNull, bare assert.ok(x)) | A plausible but wrong value still passes. | static `test.weak-assert` (regex) | low |
| `test.weakened-in-diff` | Assertions removed or loosened, tolerances raised, snapshots rewritten in bulk | The test no longer catches the bug it was written for. | review agent (eyes) | high |
| `test.never-red` | New test never seen failing on the parent commit | It may pass for the wrong reason. | review agent (eyes) | medium |
| `test.unguarded-egress` | Test can reach real third-party hosts (no egress deny, hold flag not enforced in code) | Tests send mail, register clients or post for real. | review agent (eyes) | high |
| `test.invalid-ab` | A/B or perf number with no A/A run, baseline arm, environment fingerprint or interval | Noise or a starved machine reads as an effect. | review agent (eyes) | high |
| `test.stubbed-proof` | Proof (screenshot, e2e run) produced with the path under test mocked or its route intercepted | The proof shows the stub working, not the change. | review agent (eyes) | high |
| `test.hardcoded-port` | Test or script talks to a fixed localhost port instead of its own lane | Two lanes running at once test each other's servers, so a pass proves nothing. | static `test.hardcoded-port` (regex) | medium |
| `test.stale-expectation` | Behaviour changed while tests that assert the old behaviour were not updated or not run (tests far from the touched file, path-filtered CI) | The integration branch turns red later, and whoever meets the red test first edits it to pass without knowing which side is right. | review agent (eyes) | medium |
| `test.mock-drops-exports` | Module mock written as a hand-made object, so exports added to the module later are undefined wherever it is mocked | Every later export breaks unrelated suites with undefined-is-not-a-function, far from the change that added it. | review agent (eyes) | low |
| `test.time-bomb-date` | Test compares a fixed calendar date with the real clock | It passes until that date and then fails on every branch at once, for no change of anyone's. | review agent (eyes) | medium |

## Confirm recipes

- `test.focus-skip`: static-proof: the modifier is on an added line Fix direction: remove it; quarantine a flaky test in a tracked list instead.
- `test.sleep-wait`: measurement: shuffled 5x rerun shows a failure, or the wait dominates test time Fix direction: wait for the condition (expect.poll, locator auto-wait, fake timers).
- `test.weak-assert`: measurement: a mutant returning a wrong non-null value survives Fix direction: assert the exact value or shape.
- `test.weakened-in-diff`: failing-test: run the old assertion on the new code; it fails
- `test.never-red`: failing-test: run it against the parent's source; it must fail for the stated reason
- `test.unguarded-egress`: repro-script: run with network logging; external hosts contacted
- `test.invalid-ab`: measurement: A/A pair under the same conditions shows a difference of the same size
- `test.stubbed-proof`: static-proof: the proof test intercepts the endpoint the diff changed (route mock, request handler, stubbed fetch)
- `test.hardcoded-port`: repro-script: run two lanes at once; the second talks to the first one's server Fix direction: read the base URL or port from the lane environment.
- `test.stale-expectation`: failing-test: run the full suite, not the path-filtered or touched-file subset, on the branch head; a test asserting the old value fails Fix direction: grep the tests for the old value and update them in the same commit as the behaviour, saying why in the message.
- `test.mock-drops-exports`: failing-test: import an export the mock does not list through the mocked module; it is undefined Fix direction: spread the real module (await vi.importActual / requireActual) and override only what the test needs, or mock at a narrower seam.
- `test.time-bomb-date`: failing-test: rerun with the clock set past the date (vi.setSystemTime, freezegun, faketime); it fails Fix direction: freeze the clock in the test or build the date relative to now.

## Verification steps

Run in this order after the change; each line is a pass criterion.

1. `test.v.oracle-first` acceptance checks committed before the implementation (or in the same commit with red proof) _(test; git log)_
2. `test.v.red-on-baseline` failing case run on a clean HEAD worktree, output saved _(test; evidence.mjs run)_
3. `test.v.green` same command passes on the branch, output saved with the SHA _(test; evidence.mjs rerun --expect pass)_
4. `test.v.diff-audit` no weakened assertions; any that were weakened are justified _(test; git diff -- '*test*' + scan.mjs --domain eval-testing)_
5. `test.v.mutation` mutation spot-check on the changed functions _(test; Stryker / mutmut / cargo-mutants)_
6. `test.v.shuffle` shuffled and repeated run (3-5x) of the affected suites _(test; vitest --sequence.shuffle / bun test --rerun-each)_
7. `test.v.built-app` real-browser run of the user path on the production build, screenshots with provenance _(render; Playwright)_
8. `test.v.manifest` evidence manifest (command, exit, SHA, artifact) attached to READY _(test; ready message)_

## Triggers

Loaded by `tools/unslop/classify.mjs` when the task says "test", "tests", "testing", "eval", "evals", "benchmark", "a/b", "ab test", "verify", "prove", "proof", "flaky", or touches `**/*.test.*`, `**/*.spec.*`, `**/__tests__/**`, `**/tests/**`, `**/test/**`, `**/evals/**`, `**/eval/**`, `**/__snapshots__/**`.

<!-- checks:end -->

## Tools and how to read them

| tool | how to run it | what number to read | valid only when | trap |
|---|---|---|---|---|
| red before green | run the new test on the base commit first | it fails for the stated reason | assertion message names the defect | a test that never failed proves nothing |
| mutation or fault seeding | flip the fixed line back, rerun | the test fails again | same environment | tests that pass with the bug present |
| A/A then A/B | two runs of the same arm establish noise; then interleaved arms | effect beyond the A/A spread, with an interval | decision rule written before | comparing against a remembered number |
| judge calibration | grade a labelled set with the judge | agreement with labels reported | held-out labels | a judge grading what it was shown as correct |

## Known traps

| symptom | measure | cause | fix |
|---|---|---|---|
| Suite green, feature broken | focus/skip markers in the diff | `.only` or `.skip` committed | remove; CI forbids focus |
| Flaky test | rerun 10x; find the sleep | fixed sleeps, shared state | wait on the condition; isolate state |
| READY that is not ready | independent rerun of the claimed checks | self-certified evidence | evidence.mjs rerun by another agent |

## Sources

Dated sources with their verification tags are in [SOURCES.md](SOURCES.md). Claims tagged unverified there are not stated as fact here.
