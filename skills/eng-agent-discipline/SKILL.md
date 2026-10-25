---
name: eng-agent-discipline
description: "Use for every coding-agent task, and when writing briefs, reports, READY messages, docs or handoffs. Quote the ask, stay in owned files, cite sources for claims, verify yourself before claiming done, report with evidence."
---

# The coding agent itself: scope, claims, self-verification, checkpoints: think before, prove after

The coding agent is itself a source of slop: it answers a question by changing state, edits files it does not own, explains a library from memory, says "should work" instead of showing a run, and hands over without evidence. Quote the ask verbatim and split it into directives, questions and info; keep to owned paths; cite sources for claims about tools and APIs; and end with evidence another agent can rerun.

## How this pack is used

- **Before** (`/preflight`): answer the questions for the task's tier (S: MUST, M: + SHOULD, L: all + a pre-mortem). An answer that needs a number gets a number or "unknown, measure first". Copy the budgets that apply into the pre-flight with how each is measured.
- **After** (`/unslop`): the static red flags run in `tools/unslop/scan.mjs`; the review agent reads the diff for the `eyes` ones. A red flag is a hypothesis until a confirm recipe produces evidence that a second agent reproduces.
- **Machine part**: `checks.json` in this folder (triggers, questions, budgets, rules, verify). Projects tune it in `.jstack/unslop.json` (rule modes, waivers, extra questions and rules).

<!-- checks:begin (generated from checks.json by tools/unslop/packs.mjs; edit checks.json, then render) -->

## Pre-flight questions

**MUST (asked at every tier)**

- `agent.q.quote-ask` What exactly did the user say? Quote it and mark each item QUESTION, DIRECTIVE or INFO. A question never becomes a state change. _(answer as: table; prevents: misread-intent)_
- `agent.q.scope-fence` Which files may I touch, which are forbidden, what is explicitly NOT requested, and which 'don't' constraints did the user state verbatim? _(answer as: list; prevents: forbidden-area, ignored-order, unasked-removal)_

**SHOULD (tier M and L)**

- `agent.q.acceptance` What is the acceptance check for each requested item? _(answer as: list; prevents: hallucinated-work)_
- `agent.q.sources` Which of my claims will rest on a source I have not opened yet? Open it now. _(answer as: list; prevents: claims-from-memory)_
- `agent.q.own-tools` What tools, sessions and credentials do I already hold that can verify this without the owner? _(answer as: list; prevents: asking-owner-to-test)_
- `agent.q.checkpoint` Where is my checkpoint written, and can a fresh process resume from it? _(answer as: file; prevents: lost-work)_

**DEEP (tier L, with the pre-mortem)**

- `agent.q.eta` What is my ETA from comparable past tasks, and at what point do I stop and report? _(answer as: number; prevents: no-timebox)_
- `agent.q.quotas` For any shared resource such as quotas or locks, what budget triggers proactive backoff before the hard limit? _(answer as: number; prevents: reactive-throttling)_
- `agent.q.premortem` If this fails in a week, why? Write a 3-line pre-mortem. _(answer as: text; prevents: all)_

## Budgets

Defaults with their source. The project file `.jstack/budgets.json` wins; `null` means the project sets it the first time a task touches it (pre-flight turns that into a measure-first task).

| key | default | unit | how measured | source |
|---|---|---|---|---|
| `agent.paths_outside_owned` | 0 | count | git diff --name-only against the OWNED globs | least privilege (Saltzer & Schroeder 1975); OWASP LLM06 |
| `agent.uncited_claims` | 0 | count | claims in the final report without path:line, URL or command output | Anthropic, Reduce hallucinations |
| `agent.eta_overrun_ratio` | 1.5 | x ETA | stop and report at 1.5x the stated ETA | reference class forecasting (Flyvbjerg 2006) |

## Red flags

A red flag is a hypothesis. /unslop turns it into a finding only with evidence (see Confirm recipes).

| id | what it looks like | why it is slop | detector | severity |
|---|---|---|---|---|
| `agent.git-stash` | git stash in a script (the stash stack is shared by every worktree) | refs/stash is shared across worktrees: one agent's pop applies another's work. | static `agent.git-stash` (regex) | high |
| `agent.hedged-claim` | Hedged success claim in a report or PR body ('should work', 'probably fixed') | A claim without a receipt; the owner ends up testing it. | static `agent.hedged-claim` (regex) | medium |
| `agent.unasked-deletion` | Deleted functions, exports, tests or files not named in the request | Chesterton's fence: working things vanish. | review agent (eyes) | high |
| `agent.outside-owned` | Diff touches paths outside OWNED or inside FORBIDDEN | Auth, schema or docs changed without being asked. | review agent (eyes) | high |
| `agent.ask-owner-first` | 'Can you test / click / give me access' with no tool-tried evidence | The owner does work the agent's own tools could do. | review agent (eyes) | medium |
| `agent.blame-without-repro` | 'Probably the provider / network / cache' with no repro output | The real cause stays and the fix targets the wrong thing. | review agent (eyes) | medium |
| `agent.report-only-in-chat` | Final report only in chat, nothing on disk | An interrupted agent loses everything it found. | review agent (eyes) | low |

## Confirm recipes

- `agent.git-stash`: static-proof: the command is in a script that agents run Fix direction: set work aside with a WIP commit.
- `agent.hedged-claim`: repro-script: run the claimed check; attach command, exit code, SHA Fix direction: replace with the command, its exit code and the SHA, or say 'not verified'.
- `agent.unasked-deletion`: repro-script: git diff --diff-filter=D and removed exports vs the quoted ask
- `agent.outside-owned`: static-proof: git diff --name-only against the scope fence
- `agent.ask-owner-first`: repro-script: the capability inventory shows a tool that could do it
- `agent.blame-without-repro`: repro-script: minimal repro + control run + timestamp
- `agent.report-only-in-chat`: static-proof: no report file in the run folder

## Verification steps

Run in this order after the change; each line is a pass criterion.

1. `agent.v.scope` changed paths vs OWNED and FORBIDDEN; every deletion justified or reverted _(test; git diff --name-only / --diff-filter=D)_
2. `agent.v.trace` each ledger item DONE with evidence or explicitly DEFERRED _(test; .agent/brief.md checklist (ready-gate))_
3. `agent.v.claims` each factual claim in the report has a source; the rest is removed or marked unverified _(test; report review)_
4. `agent.v.self-verify` tests, typecheck and an end-to-end check with my own tools before asking any human _(test; test runner + browser automation)_
5. `agent.v.resume` long orchestration: kill and relaunch; no duplicated side effects _(test; kill test)_

## Triggers

Loaded by `tools/unslop/classify.mjs` when the task says "agent", "agents", "subagent", "orchestrator", "brief", "handoff", "report", "docs", "documentation", "claude.md", "resume", "checkpoint", or touches `.agent/**`, `**/CLAUDE.md`, `**/AGENTS.md`, `.claude/**`, `**/*report*.md`, `**/pr-body*.md`.

<!-- checks:end -->

## Tools and how to read them

| tool | how to run it | what number to read | valid only when | trap |
|---|---|---|---|---|
| ask table | the first section of `.agent/preflight.md`: each item tagged DIRECTIVE, QUESTION or INFO | no QUESTION turned into a state change | verbatim quote | acting on a question |
| scope fence | OWNED and FORBIDDEN paths in the pre-flight; `git diff --name-only` before READY | every touched path is owned | compare against the fence | drive-by edits in shared files |
| claims with sources | every statement about a library, API or model links the doc or code read | no claim from memory | primary source | "as far as I know" |
| self-verification | rerun the acceptance checks from a clean state | each check passes with its output kept | evidence.mjs captures SHA and environment | hedged words in the report |

## Known traps

| symptom | measure | cause | fix |
|---|---|---|---|
| Question answered with a code change | compare the ask table with the diff | question read as an order | answer; change only on a directive |
| Another agent's work lost | git stash list; reflog | shared stash or checkout | own worktree; never stash |
| READY bounced | rerun the claimed checks | claims without evidence | evidence files in the READY message |

## Sources

Dated sources with their verification tags are in [SOURCES.md](SOURCES.md). Claims tagged unverified there are not stated as fact here.
