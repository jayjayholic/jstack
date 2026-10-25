# How /unslop is measured

/unslop is a classifier with a cost. It gets the same treatment any judge should: fixtures, a held-out set, field data, and demotion of rules that don't earn their place.

## 1. Static layer: golden fixtures

- `fixtures/dev/<domain>.json` holds, for every static rule, at least one `slop` case (must fire at the given lines) and two `near-miss` cases (clean code that looks like the slop and must stay silent). Each case is a tiny repo: `files`, optional `diffStatus` for diff-aware script rules, and `expect`.
- `fixtures/holdout/<domain>.json` holds different shapes of the same slop, written after the rules and never used to tune them.
- `node tools/unslop/selftest.mjs` prints per rule TP, FP, FN, precision and recall with Wilson 95% intervals, separately for dev and holdout. It fails when a dev case fails or a static rule lacks its 1 + 2 cases. `node --test tools/unslop/` runs every dev case as its own test.
- When the dev and holdout precision intervals of a rule don't overlap, the rule is overfit: the report says so and the rule goes back to `eyes-hint`.
- Adding a rule means adding its three cases in the same commit. `/unslop learn` writes them for a confirmed finding.

## 2. Agentic layer: a seeded app (planned)

A small multi-file app with planted slops across domains plus decoys that look wrong and aren't, with the ground truth outside the agents' reach. A run copies it into a temp repo, makes the planted commit the diff, runs the full pipeline and scores:

- human-facing precision: confirmed findings that match a planted slop over all confirmed. Target 1.0; any confirmed decoy fails the run.
- recall per domain and overall, with Wilson intervals.
- dismissal accuracy on decoys that reached confirm.
- evidence validity: confirmed findings whose evidence passes an independent rerun.
- cost, wall time, agents spawned, peak RAM.

Two runs on the same commit first (A/A) to know the noise; any prompt or rule change is compared with interleaved repeats, Hodges-Lehmann on cost and time, a two-proportion test on recall. Not built yet: the seeded app needs a maintainer rule (every new static rule adds one planted slop and one decoy) before it is worth its tokens.

## 3. Field precision and demotion (per project)

- Every reported finding gets a verdict from the human or the fixing agent: `accepted`, `rejected:<reason>` or `duplicate`, appended to `.jstack/local/feedback.jsonl`.
- `tools/unslop/rules.mjs` computes per-rule field precision with the Wilson lower bound. Rules start in `warn`. A pack rule marked `block-when-confirmed` only blocks the gate once its lower bound is >= 0.8 over >= 10 verdicts; any rule drops to `eyes-hint` when its lower bound falls under 0.5 over >= 10, and the report names the demotion. A project can pin a mode in `.jstack/unslop.json`.
- Pipeline guard: rejected human-facing findings over all human-facing findings in the last 30 days goes in every report header. Target: upper bound <= 5%. Above it, the next run needs two skeptics to agree before CONFIRMED.

## 4. Recall on real code: canary injection (planned)

In a scratch worktree, inject known slops from the fixtures into real files, run the gate and /unslop on that diff, delete the worktree. Measures recall on the project's own code style. Never commits, never pushes.
