---
name: eng-ci-git
description: "Use when a change touches CI, build, typecheck, merges and rebases, branches and worktrees, release trains, exported signatures or renames. Gate the merged tree, find every caller, resolve conflicts by reading them."
---

# CI, build, tooling and git/train hygiene: think before, prove after

Keep the integration branch always green by checking what will actually land: the merged tree, not each branch alone. A changed export has callers in other branches; a blanket `-X ours/theirs` drops hunks unread; a skipped hook ships what it would have caught. Resolve conflicts file by file and run one integration check per merge.

## How this pack is used

- **Before** (`/preflight`): answer the questions for the task's tier (S: MUST, M: + SHOULD, L: all + a pre-mortem). An answer that needs a number gets a number or "unknown, measure first". Copy the budgets that apply into the pre-flight with how each is measured.
- **After** (`/unslop`): the static red flags run in `tools/unslop/scan.mjs`; the review agent reads the diff for the `eyes` ones. A red flag is a hypothesis until a confirm recipe produces evidence that a second agent reproduces.
- **Machine part**: `checks.json` in this folder (triggers, questions, budgets, rules, verify). Projects tune it in `.jstack/unslop.json` (rule modes, waivers, extra questions and rules).

<!-- checks:begin (generated from checks.json by tools/unslop/packs.mjs; edit checks.json, then render) -->

## Pre-flight questions

**MUST (asked at every tier)**

- `ci.q.ci-command` What exact command does CI run, and can I run it locally on the merged tree (base + my branch)? _(answer as: text; prevents: self-certified-ready)_
- `ci.q.callers` Which exported symbols or contracts does my change touch, and who calls them? _(answer as: list; prevents: broken-caller)_

**SHOULD (tier M and L)**

- `ci.q.asked-for` Is every new component (infra, service, workflow, dependency) named in the request? If not, have I asked? _(answer as: text; prevents: unasked-infra)_
- `ci.q.irreversible` Which actions are irreversible or outward (push, merge, force, admin, delete, billing)? Do I have explicit approval for each? _(answer as: list; prevents: unapproved-push)_
- `ci.q.build-budget` What is my build budget (typecheck time, peak RSS, deploy machine memory), and what is the baseline? _(answer as: number; prevents: build-oom)_
- `ci.q.cleanup` What will I create (worktrees, branches, servers, caches), and when will I delete it? _(answer as: list; prevents: sprawl)_

**DEEP (tier L, with the pre-mortem)**

- `ci.q.dependencies` Which external dependencies (CI minutes, deploy provider, quota, keys) must be up, and how do I see they are? _(answer as: list; prevents: billing-stall)_
- `ci.q.queue` What is the merge queue length and service rate right now, and what wakes me when it changes? _(answer as: number; prevents: idle-waits)_
- `ci.q.location` Where does the platform expect this artifact to live (skills, env files, configs), per its docs? _(answer as: text; prevents: wrong-location)_
- `ci.q.premortem` Pre-mortem: it is a week later and this broke the integration branch. Why? _(answer as: text; prevents: train-bounce)_

## Budgets

Defaults with their source. The project file `.jstack/budgets.json` wins; `null` means the project sets it the first time a task touches it (pre-flight turns that into a measure-first task).

| key | default | unit | how measured | source |
|---|---|---|---|---|
| `ci.train_bounce_rate` | 0 | ratio | trains dropped because of this branch / trains it boarded | Not Rocket Science Rule; merge queues |
| `ci.typecheck_s` | null | s | tsc --extendedDiagnostics Check time vs baseline | TypeScript wiki Performance |
| `ci.build_peak_gb` | null | GB | peak private bytes of the build tree (mem_map / heavy_capped log) | deploy machine memory table |

## Red flags

A red flag is a hypothesis. /unslop turns it into a finding only with evidence (see Confirm recipes).

| id | what it looks like | why it is slop | detector | severity |
|---|---|---|---|---|
| `ci.conflict-marker` | Conflict marker committed | The file no longer parses, or both sides ship half each. | static `ci.conflict-marker` (regex) | high |
| `ci.blanket-merge-side` | Blanket -X ours/theirs or checkout --ours/--theirs over many files | Every conflicting hunk is resolved unread; exports, imports and catalog keys disappear silently. | static `ci.blanket-merge-side` (regex) | high |
| `ci.skip-hooks` | Hooks bypassed (--no-verify, HUSKY=0, SKIP_HOOKS) | The check that would have caught the break never runs. | static `ci.skip-hooks` (regex) | high |
| `ci.signature-callers` | Exported signature changed with fewer callers updated than a search finds | Another package or adapter breaks at runtime or in the train. | review agent (eyes) | high |
| `ci.unasked-infra` | New Dockerfile, runner, workflow or service not named in the request | Somebody now owns and pays for a thing nobody asked for. | review agent (eyes) | medium |
| `ci.heap-bump-fix` | OOM 'fixed' by raising --max-old-space-size without a profile | The real growth stays; the next build OOMs on a bigger machine. | review agent (eyes) | medium |
| `ci.ready-without-proof` | READY/done with no command, exit code and SHA attached | The train bounces and the owner re-checks by hand. | review agent (eyes) | high |

## Confirm recipes

- `ci.conflict-marker`: static-proof: the marker line is in the tree Fix direction: resolve the hunk by reading both sides (git show :2:path / :3:path).
- `ci.blanket-merge-side`: static-proof: the option is in a script; train merged-tree check finds lost keys or exports Fix direction: resolve conflicts file by file; union only for append-only files.
- `ci.skip-hooks`: static-proof: the flag is in a script or workflow Fix direction: fix what the hook reports.
- `ci.signature-callers`: failing-test: workspace typecheck or the caller's test fails on the merged tree
- `ci.unasked-infra`: repro-script: quote the request; the component is not in it
- `ci.heap-bump-fix`: measurement: --extendedDiagnostics or trace shows the hot file
- `ci.ready-without-proof`: repro-script: run the CI command on the stated SHA; it fails

## Verification steps

Run in this order after the change; each line is a pass criterion.

1. `ci.v.merged-tree` gate on the merged tree: rebase, format check, lint, typecheck, tests; record exit codes + SHA _(test; ready-gate.sh)_
2. `ci.v.markers` git diff --check and the conflict-marker scan return nothing _(test; git diff --check; scan.mjs)_
3. `ci.v.callers` dependents' tests ran; workspace typecheck green _(test; turbo --filter=...pkg / LSP references)_
4. `ci.v.budget` Types / Check time / Memory from --extendedDiagnostics and build peak vs baseline _(measure; tsc --extendedDiagnostics; mem_map)_
5. `ci.v.clean-rebuild` any unexplained error reproduced from a clean tree on the same SHA before a code change _(test; clean caches + rerun)_
6. `ci.v.cleanup` worktrees, branches and servers I started are gone _(test; git worktree list; netstat)_

## Triggers

Loaded by `tools/unslop/classify.mjs` when the task says "ci", "build", "pipeline", "workflow", "merge", "rebase", "conflict", "branch", "worktree", "train", "typecheck", "lint", or touches `.github/**`, `**/*.yml`, `**/*.yaml`, `**/Dockerfile*`, `**/package.json`, `**/tsconfig*.json`, `**/turbo.json`, `scripts/**`.

<!-- checks:end -->

## Tools and how to read them

| tool | how to run it | what number to read | valid only when | trap |
|---|---|---|---|---|
| merged-tree gate | `node tools/unslop/gate.mjs --train` after the integration typecheck | no conflict markers, no lost catalog keys, unique migration stamps | run on the merge result, not a branch | a train that merged clean and builds red |
| callers of a changed export | `git grep -n "<symbol>"` across the integration branch and open branches | every caller updated or still compatible | search the merged tree | a rename that only compiles on its own branch |
| typecheck diagnostics | `tsc --extendedDiagnostics` / `--generateTrace` | check time and memory within budget | one heavy job at a time (heavy-lock) | two parallel builds starving the machine |
| worktree hygiene | `git worktree list --porcelain`, `git stash list` | one worktree per live agent; stash empty | clean up finished worktrees | shared stash clobbering another agent |

## Known traps

| symptom | measure | cause | fix |
|---|---|---|---|
| Exports or keys vanish after a merge | diff the merge against both parents | blanket merge strategy | resolve per file; gate the merged tree |
| Green branch, red train | typecheck the merged tree | callers in other branches | git grep callers before changing a signature |
| Build OOM with parallel agents | mem-map during the build | heavy jobs not serialized | heavy-lock; one build slot per machine budget |

## Defers to

`/train` for shipping several branches.

## Sources

Dated sources with their verification tags are in [SOURCES.md](SOURCES.md). Claims tagged unverified there are not stated as fact here.
