# Changelog

Each entry says what changed and which problem it fixes.

## 2026-10-26 (2): admission counts only unused reservations, and frees dead or hung slots

**What:**
- `run-capped.ps1 -StatusFile`: while the job runs it rewrites `<pid> <used GB> <cpu s> <cpu idle since> <now>` every `JSTACK_STATUS_EVERY_S` (15 s): private bytes summed over the Job Object's processes, and the job's CPU time. `heavy_capped` points it at the slot (`<slot>/status`) and removes it after the run.
- Admission subtracts from available RAM only what a running job has not used yet: max(0, need - used). Its used memory is already missing from "available"; counting the whole reservation again double-counted it.
- Slots record their `holder` (the shell waiting or running in them). A slot whose holder is gone and whose status is not fresh (`JSTACK_STATUS_FRESH_S`, 60 s) reserves nothing; a typecheck lane in that state is removed, so the next `tc_run` takes it instead of waiting behind a dead lock. A dead heavy slot keeps its folder (heavy_acquire and the build may be separate calls) but reserves nothing.
- Hung: a job with no CPU progress for `JSTACK_HUNG_MIN` (15 min) while holding a slot reserves nothing and gets one `hung-slot` line in the warden's `notices.jsonl` (`perf.mjs notices`). It is never killed by the lock.
- A slot whose job still reports status is never swept as stale, however long it runs.
- Tests: 5 new in `tools/heavy-lock.test.mjs` (15).

**Why:** found live within the hour. With a build at 14 of its 16 GB, admission still subtracted all 16 from an "available" that already lacked the 14, so lanes waited on memory nobody would use. And a typecheck lane whose `tsc` froze (no CPU for 30 min) or whose shell died kept its lock: the wrapper that releases it never ran again, and everything queued behind it. The tests use Git's `usr/bin/bash.exe`: a timeout on the `bin/bash.exe` launcher killed only the launcher, and the real shell kept waiting in admission and took lanes from the next test.

## 2026-10-26: heavy jobs admitted by measured RAM, and the heavy-lock guard closes its bypasses

**What:**
- `heavy-lock.sh`: admission by measured RAM. Once `heavy_acquire` or `tc_run` holds its slot, the job starts only when available RAM minus what the other jobs reserved covers its need. The need is the job's measured peak (max of its last 5 runs, plus 15%), else `JSTACK_HEAVY_MIN_AVAIL_GB` / `JSTACK_TC_MIN_AVAIL_GB`, at most `JSTACK_ADMIT_MAX_GB` (16). Each slot writes `need` and, once admitted, `admitted`. Admitted jobs count their full need against everyone; a build still waiting counts against typecheck lanes (lanes yield to it, so it never starves); waiting lanes count against nobody (no deadlock); a slot from an older script with no `need` file counts its cap; the caller's own heavy slot never counts.
- The wait never gives up by itself: no more "15 min, then run anyway". A status line every `JSTACK_ADMIT_SAY_S` (300 s) gives available, reserved and minutes waited; `heavy_acquire <name> --force`, `tc_run --force` or `JSTACK_ADMIT_FORCE=1` start it now. `--need GB` overrides the need. `MEM_GUARD=0` still turns admission off. The 90 s stagger between lanes is gone (the other lane's reservation covers its ramp-up). The waiting slot touches its owner file, so the 45-minute stale sweep never steals it.
- `heavy_capped` records each run's peak (`run-capped.ps1 -PeakFile`, the Job Object's peak commit) in `~/.jstack/job-peaks.tsv` under the slot name up to its first colon (`coordinator:wt-a` -> `coordinator`), or `typecheck` for `tc_run`. Windows only; elsewhere the defaults apply.
- Guard: the heavy-lock guard also catches `bun x next build`, `bunx --bun`, `bun run --bun`, `bun next build`, `pnpm next build`, `npx -y`/`--yes`, `npm exec -- tsc`, `timeout 600 …` and `nice …`. It passes a caller whose worktree already holds the heavy slot (owner line `@ <worktree>`; `heavyLock.lockDir`, else `JSTACK_LOCK_DIR`; `"holderPasses": false` turns that off), a `tsc --noEmit` on one named file, and anything outside a git repo. An unreadable owner file means "not held"; a hook error still exits 0 and never blocks.
- Tests: `tools/heavy-lock.test.mjs` (10, bash with a stubbed RAM reading, including a replay of the night's stack against the old script) and 5 new guard tests (42 in `hooks/`).

**Why:** at 01:14Z a build holding the heavy slot (`skills-loop-pool`, Turbopack, which ignores the heap cap) climbed to 22.6 GB while a second `next build` ran beside it in a typecheck lane: the lane's wait for the heavy slot and its RAM wait each gave up after 15 minutes, and 14 GB "available" passed the old fixed 10 GB check. Four minutes later the machine had 1.35 GB available. Separately, probing the guard with 29 spellings of a build or typecheck found 14 that passed unwrapped (`bun x next build`, `npx -y next build`, `timeout 600 bun run typecheck`, ...). Replayed with the same lock state: the old script started the second job in 1.3 s; the new one waited until the slot was released. The 32 GB laptop would like it noted that it was never asked.

## 2026-10-26: a red flag for the native scrollbar on a dark UI

**What:** `eng-ui-visual` gets the red flag `ui.native-scrollbar` (a native or default scrollbar on a themed or dark UI), its confirm recipe (dark theme, phone and desktop, look at every scroll area), the verification step `ui.v.scrollbar` and a known-trap row with the fix: one base rule with `color-scheme` per theme and a `::-webkit-scrollbar` pill from a token, the standard `scrollbar-color`/`scrollbar-width` only under `@supports not selector(::-webkit-scrollbar)`, and no per-component overrides.

**Why:** an admin page shipped with a bright white native scrollbar on its dark theme, and the owner's verdict was "horrible". The cause was generic (no `color-scheme`, no global scrollbar style), so three apps had it. A second trap showed up during the fix: in Chromium, setting `scrollbar-color` or `scrollbar-width` switches off `::-webkit-scrollbar` and brings back the arrowed native bar, so the "standard" fix still looked native. Only a render in the dark theme catches either, which is why the check is a look, not a lint. The 32 GB laptop rendered 40 screenshots to prove a stripe of eight pixels.

## 2026-10-25 (late night, 3): a scan note for scoped grep, and a tip list measured

**What:**
- Scan guard: a scoped `grep -r` still passes, but the first one per agent gets a note (additionalContext, never a block): the Grep tool or `git grep` is 2-3x faster, and grep's backslash-pipe alternation is a literal pipe to rg. Off with `"scans": { "nudge": false }`. Two new tests.
- README, RAM section: a collapsed table with the verdict and the numbers for each tip (TypeScript 7, oxfmt, oxlint, ripgrep, cloud checks).
- `eng-machine`: two known traps (TS 7 checkers vs RAM, grep vs rg) and three dated sources.

**Why:** a LinkedIn post listed ways to cut CPU and RAM with many agents on one machine. Measured on the dashboard instead of believed: TypeScript 7 is 9x faster but uses 1.2 GB more at its default 4 checkers (`--checkers 1` saves 2.4 GB for 19 s); oxfmt is 190x faster at `--check` but disagrees with Prettier on 68 files; agents made about 25k recursive greps in a week (14k scoped, which the guard allows) and 39% of all agent greps use `\|`, so the "symlink grep to rg" tip would have broken them silently. The scan guard had already blocked 271 root-wide scans, and 77% of the next calls took the advice. The 32 GB laptop finally won an argument with LinkedIn.

## 2026-10-25 (late night, 2): the warden ends an orphaned xargs too

**What:** `xargs` joins the warden's short dev tools (killed when orphaned for 10+ min).

**Why:** a `find | xargs grep` over two weeks of task outputs outlived its Bash tool timeout. The warden killed each `grep` batch at 10 min, and the surviving `xargs` started the next one, every 10 min for hours at ~99% of a core (the `respawning-orphan` trigger). Under Git Bash a child's Windows parent is a fork stub that exits, so `xargs` looks orphaned too; killing it ends the chain. Tests: new warden case, suite green.

## 2026-10-25 (late night): the warden and the optimizer

**What:**
- `tools/perf/warden.mjs`, run by the collector after every tick: kills orphaned dev tools (`grep`, `rg`, `find`, `xargs`, `tail`, `sleep`, `tsc`, `tsgo`, `esbuild` after 10 min; idle `node`/`bun` in agent worktrees and automation browsers after 30 min idle), with a protect list it never crosses (agent CLI, MCP, Docker/WSL, editors and language servers, jstack's tools, the heavy-lock holder's worktree, `keep-browser` pids, main checkout servers, unreadable command lines, any tree containing one). Runs the RAM clean task under 10% available (ram-clean.ps1's cooldown stamp, 10 min minimum). Flags tests at 90%+ of a core for 15+ min to `notices.jsonl` without killing them. Stops a configured Docker Compose project after 30+ min with no container CPU, no TCP client and no eval process. Writes triggers for the optimizer. Modes act/dry/off; a failing step is logged and the tick continues. Every action, and available RAM one tick later, goes to `actions.jsonl`.
- `perf.mjs ensure | actions | notices | optimizer due|start|finish | floor | search-exclude`, and `search-scope.cs` (the Windows Search Crawl Scope Manager API: no admin needed here; a one-click elevated script otherwise).
- `PERF.md` sections 5-7: the warden, the optimizer agent (floor, priority by expected saving, `at-floor`, what it may do alone and what it only proposes) and the exact prompt. `/train` and `/train-compound` run `perf.mjs ensure` at the start and `perf.mjs optimizer due` every watch round, launching one background optimizer when due.

**Why:** the log only helps if someone acts on it, and on a busy night nobody does. The safe part (orphans, RAM clean, idle stacks) needs no judgment, so it runs every minute without a session; the part that needs judgment (is there a cheaper tool, is this load just the work) is an agent, launched only when there's something to look at. Its first dry-run tick found an orphaned `find` 196 min old, two `tail -f` nobody read for up to 172 min and an orphaned `grep` at 56% of a core, with available RAM at 1.25 GB. Tests: 336 green (18 new, the kill policy among them).

## 2026-10-25 (night): a performance log, a panel, and an optimize loop

**What:**
- `tools/perf/`: a collector that writes one line a minute (configurable) to `~/.jstack/perf`: CPU % per process over the interval (100% = one core), private and working-set memory, I/O, attribution to worktree and agent (mem-map's rules; agent names from the new `mem-map.ps1 -Agents`), the heaviest processes with redacted command lines, machine CPU/RAM/commit/file cache/pagefile/disk queue, CPU no live process explains, and heavy-lock holders. Past days are gzipped and rolled up to 5 minutes (90 days) and hours (400 days); raw ticks stay 14 days.
- `perf-snap.cs`: one `NtQuerySystemInformation` call per tick, compiled at install with the C# compiler that ships with Windows (no binary in git). Its `run` mode measures a command's whole process tree in a Job Object.
- `perf.mjs`: `install`/`uninstall` (a scheduled task: at logon plus a 5 min self-heal, battery-safe, no admin), `status`, `top`, `agents`, `spikes`, `at <time>`, `patterns` (grep storms, duplicate typechecks, parallel builds, long-lived browsers, idle servers, stuck busy processes, short-lived churn), `panel` (a static HTML page), `csv`, `bench`, `ledger`.
- `machine-memory` skill: section 6 and `PERF.md` with the watch routine and the optimize loop (primary sources, interleaved bench, adopt only when faster AND lighter with the same result, a ledger line either way).
- First round of the loop, adopted: `jstack_free_gb` falls back to node before PowerShell (735 to 48 ms, 63 to 17 MB, same number), and `proc-table.mjs` gives the guard hooks' process table from perf-snap (682 to 68 ms, 484 to 62 ms of CPU, 105 to 19 MB, identical pids, parents, names and command lines). The hooks file itself is untouched; swapping its `listProcesses` to `listProcessesFast()` is a one-line follow-up.
- `mem-map.ps1`: `-Agents`, `-Classify` (a parity test runs both implementations on the same rows), and a global `bun`/`npm` install under AppData is no longer taken for a project.

**Why:** `mem_map` tells you who holds memory right now, not who made the laptop crawl twenty minutes ago, and nobody kept the numbers to find out what to make cheaper. The macOS stack that inspired this needs node_exporter, Prometheus and Grafana; this needs node and the compiler Windows already has. Measured cost on this machine over its first 15 minutes: 0.07% of one core for the collector plus 0.09% for the snapshot (0.008% of the 20-thread machine), 21 MB private (22 to 42 MB working set) and a 16 MB snapshot process for about 150 ms a minute. The first draft read the disk queue through performance counters and that alone cost 600 ms of CPU per tick. In its first 15 minutes it caught a test spinning at 98% of a core for 15 minutes, an orphaned grep doing the same for over an hour, and Windows Search spending most of a core indexing the worktrees. Tests: 304 green (25 new). UNVERIFIED: the macOS/Linux `ps` path, and `bench` is Windows-only. The laptop now has a diary. It reads like a crime novel.

## 2026-10-25: pre-flight by default, scaled to the task

**What:**
- `hooks/jstack-preflight.mjs` (PreToolUse on Edit/Write/MultiEdit/NotebookEdit, through the fail-safe `run-hook.mjs`): on an agent's first edit in a git repo with no `.agent/preflight.md` for the branch, one note with the suggested class (quick / light / full) and the signals behind it: risk paths (migrations, schema, auth, permissions, payments, billing, prompts, model-call files), the first 700 characters of the ask (quick words like hotfix/rápido, risk words like migration/idempotent/webhook, feature words), the branch prefix, the diff so far. One more note at most if a quick class reaches a risk path or grows past 8 files / 300 lines. Never denies. Off with `JSTACK_PREFLIGHT=off` or `"preflight": {"enabled": false}`.
- Packs in context while coding: once a pre-flight names its domains, the next edit gets those packs' questions and red flags for its tier (about 300 tokens a pack), once per domain set.
- `/preflight` step 0: class the task. Quick is one line, light is four (`ask`, `check`, `scope`), full is the existing ten steps. The skill's description now says when to skip, so it triggers on features, not on every typo. Both `/preflight` and `/unslop` say where `tools/` is when `{{JSTACK_TOOLS}}` was never filled (plugin installs).
- `ready-gate.sh` check 7 accepts `class: quick` and `class: light` (light needs its three lines).
- Worker clause: class first; full (or light with domains) runs `/unslop --base origin/<integration> --fix` before READY without being asked and puts the counts in the READY line; quick skips it.
- Version 0.10.0: plugin caches refresh only on a version change, and the author's 0.9.0 cache had no preflight, unslop or packs at all (the hook would never have loaded).
- Fixed a clash inside the kit: the worker clause wrote the agent-name marker as a FILE called `.agent`, while pre-flight and the brief live in a FOLDER called `.agent/`, so in those worktrees `.agent/preflight.md` could not be created (4 of my worktrees had the file). The marker is now `.agent/name`; `mem-map.ps1` reads either; the hook points out a leftover file.
- Tests: `hooks/jstack-preflight.test.mjs`, 14 cases (fires once per agent, other agents get their own, ignores non-git dirs, `.agent/` files and non-edit tools, quick class silences it, risk-path and growth escalation once each, packs digest once, other-branch pre-flight counts as missing, env and config opt-out, broken config and garbage stdin exit 0 silently, class signals both ways, digest size bound).

**Why:** an audit of the first day with /preflight and /unslop: of ~8 coding agents started after the kit landed, one ran /preflight (because my brief said so) and none ran /unslop. The dashboard's own train clause never mentioned either, briefs mostly didn't, and the skill text pointed at a `{{JSTACK_TOOLS}}` folder that plugin installs never fill. The owner wants prevention by default, but not a ceremony on a hotfix: so the hook nudges, the agent picks the class, and a quick fix costs one line. Replayed on 11 real tasks: about 250 tokens and 70-690 ms once per agent; quick for the 3 hotfixes, full for the 2 feature branches and 1 "implement" fix, light for the 5 unclear fixes. Unverified: how often agents follow the note. The 32 GB laptop read the note too and classed itself "full".

## 2026-10-25: a README that gets to the point

**What:**
- README rewritten top-down: a one-line pitch, the two install lines, a "what you get" table and a one-line table of contents come first. Every feature area (trains, preflight and unslop, RAM, guard hooks, browser cleanup, worktrees, domain packs, /optimize, the account switcher) gets one or two plain sentences, and its lists, tables, flags and long explanations sit in collapsed `<details>` blocks. The FAQ is one collapsed block per question.
- Nothing dropped: every command, install path, opt-in (`guards.json`, `"browsers"`, `"watch"`, `memory.mjs init`), opt-out (`keep-browser`, `--accept-config-change`) and caveat (UNVERIFIED Linux/macOS cleanup, untested RAM ceiling outside Windows, not built yet) is still there. New: the `unslop@jstack` install line, a 16-pack table with when to use each, and the `JSTACK_READY_*` gate vars in the settings table.
- Badges: the static skills-list badge is gone, a real license badge joined the others.

**Why:** the old README opened with five paragraphs of story before you knew what to install, and the useful lists were walls of text. Now a visitor reads three lines and knows what it is and how to try it, and the details are one click away. The 32 GB laptop jokes stayed. The laptop insisted.

## 2026-10-26: six security fixes, a front desk for /unslop, and the pages that explain and measure it

**What:**
- Security, each with regression tests:
  - `memory/anchors.mjs`: an anchor's commit must be 7-40 hex characters that name a real commit (`rev-parse --verify --end-of-options <c>^{commit}`), every git call puts `--end-of-options` before revisions, and anchor paths that are absolute, contain `..` or start with `-` are refused by `validate()`, `makeAnchor()` and `resolveAnchor()`.
  - `memory/secrets.mjs`: every occurrence of a gitleaks-reported secret is redacted, not only the first.
  - `unslop/scan.mjs`: memory waivers expire like `unslop.json` ones, and a waiver on a high-severity rule needs an expiry. In diff mode config and memory suppressions come from the merge-base; what the branch adds is reported as `unslop.config-changed` / `unslop.new-waiver` (high) and `unslop.new-suppression` (at the hidden rule's severity).
  - `unslop/gate.mjs`: mode and thresholds come from the base's config, "off" in a config reads as warn, only `--mode off` / `JSTACK_READY_UNSLOP=off` turns it off, and a config change in the diff blocks until `--accept-config-change` (or `JSTACK_UNSLOP_ACCEPT_CONFIG=1`).
  - `unslop/ledger.mjs`: static proof needs a rerun by a different agent and is decided on the latest one, like every other evidence kind.
- `/unslop` front desk (`desk.mjs`): suggests the scope (open PR, else this branch, else recent commits; full project listed, never default) with static hits, domains and estimated agent runs, runs up to the report, shows it, and asks before fixing; fixes go confirm, test red, fix, re-test.
- `metrics.mjs`: every run leaves a before/after record in `.jstack/metrics/runs/<run>.json` (report.mjs writes it): counts per domain and rule, fingerprints, time to fix, verdicts, budgets met, and which pre-flight questions would have caught each finding and whether they were asked. `metrify.mjs` draws the trend: per domain, top recurring slop, each rule's effect and false-positive rate, the questions to start asking.
- `explain.mjs`: a static page per run (blame, scenario, technique, cited pack sources, before/after evidence, research notes). `feedback` records verdicts (they move rule thresholds); `prefer` writes a new `preference` memory kind (short/full, mute) that later pages follow.
- `mine.mjs` (`/unslop:retro`): fix commits plus complaint-like messages from transcripts, clustered by domain, with late-fix ratio, escapes per domain, median days to fix, and draft questions and eyes rules for uncovered clusters.
- `adapters.mjs`: rules with `"engine": "semgrep"` or `"ast-grep"` run when the tool is installed (no shell, paths after `--`, hits cut to added lines); missing tool means "not checked" or the rule's fallback.
- New plugin `plugins/unslop` so the side commands type as `/unslop:explain`, `/unslop:metrify`, `/unslop:retro`.

**Why:** the commit-time review of the last drop flagged that the tools trusted the very branch they judge. An anchor commit like `--output=pwned.txt` made `git diff` write a file (reproduced before the fix); a branch could waive its own slop, switch rules off or set its own gate to off; expired waivers kept hiding hits; a prosecutor could rerun its own static proof and call it confirmed; and a token pasted twice was redacted once. Then the owner asked for the Claude Security plugin's front desk: suggest what fits before anything costly, report first, fix only after a yes. And for the two pages that close the loop: one that explains each finding so a human learns something, and one that shows over time whether the same slop stops coming back. Tests: 279 (251 unslop + memory, 28 hooks + worktree-deps), self-test 164 dev and 36 holdout cases at 100%, packs check green. Unverified: real semgrep and ast-grep runs (neither is installed here, the tests fake them), and the retro drafts are keyword-level, so a human edits them. Still not built: the seeded agentic eval, canary injection, the hook that denies hand edits of `.jstack/memory`. The 32 GB laptop rendered two dashboards today and asked if that counts as a build. It does not.

## 2026-10-25 (late): a completeness pass over the packs

**What:**
- 8 more pre-flight questions and 27 more red flags, each with a confirm recipe. 7 are static with golden fixtures (dev + holdout): raw palette classes, a literal language passed to a call, checks that can't fail the job (`continue-on-error`, `|| true`), tests on a fixed localhost port, nested regex quantifiers, Markdown links to missing repo paths (new `md-dead-link` script check). `ci.skip-hooks` now also catches `gh pr merge --admin`, and the prompt-language rule catches "in Brazilian Portuguese" and "in pt-BR".
- `classify.mjs`: each pack learns the words people use when they report the failure ("slow", "stuck", "cursor", "deep link", "leak", "twice", "credits"), and agent-discipline joins eval-testing as a companion.
- The sources the port dropped from the research tables are back (viewport units, dialog Esc order, CLS, hydration, merge strategies, hook bypass, `dotenvx --strict`, fail-open).
- `worktree-deps.mjs`: no product-specific codegen folders by default. Packs say "user", not "member".

**Why:** I checked the 221 mined failures one by one. Each one should get a pre-flight question that would have caught it and a red flag that `/unslop` can prove. 174 had both. 12 are process failures, like a commit made before approval, that no diff can show, so a question is the right check for them. The other 35 had no question, no provable flag, or neither. Now they have both. On those same failure texts, the classifier picked the right pack for 55 of 221. Now it picks it for 114 and lists it as a weak hit for 90 more. Those numbers come from the cases the words were tuned on, so treat them as an upper bound.

## 2026-10-25 (night): think before, prove after: /preflight, /unslop, 16 domain packs and project memory

**What:**
- `skills/preflight/` (`/preflight`, `TEMPLATE.md`, `RISK.md`): quote the ask and tag each item DIRECTIVE / QUESTION / INFO, tier the risk S/M/L on six axes, pick the domain packs with `tools/unslop/classify.mjs`, read project memory, answer the packs' questions for the tier, and write budgets with their measurement, runnable acceptance checks, a verification plan and a scope fence into `.agent/preflight.md`. The checks are appended to `.agent/brief.md`.
- `skills/unslop/` (`/unslop`, `EYES.md`, `CONFIRM.md`, `EVIDENCE.md`, `SELF-EVAL.md`): scan, triage, confirm (blind prosecutor + a skeptic who reruns), test red, propose, fix, re-test, record. Modes `--fix`, `--full`, `--domain`, `--train`, `learn`, `retro`.
- 16 domain packs `skills/eng-*` (performance, ui-visual, interaction, i18n-a11y, copy, data-privacy, concurrency, ci-git, machine, llm-app, llm-cost, eval-testing, security, data-quality, agent-discipline, deploy-config): `checks.json` (triggers, tiered questions, budgets, 121 red flags of which 47 are static rules, verify steps), a SKILL.md whose middle is generated from it (`tools/unslop/packs.mjs render|check`), and `SOURCES.md` with the dated sources and verification tags of the research they came from.
- `tools/unslop/`: `scan.mjs` (added lines by default, `--full` via `git ls-files`, never a disk walk; fingerprints stable across line shifts; inline `unslop-ignore: <rule> <reason>`), `rules.mjs` (packs + `.jstack/unslop.json` tuning, house banned words, field precision and demotion), `ledger.mjs` (the finding state machine; CONFIRMED needs an independent reproduced rerun, VERIFIED a passing re-test), `evidence.mjs` (runs and reruns evidence with commit, dirty flag, machine state, redacted output), `report.mjs` (only CONFIRMED-or-later rows with evidence that still holds), `gate.mjs` (fast mode for ready-gate, `--train` for the merged tree), `classify.mjs`, `selftest.mjs`, `stats.mjs`.
- `skills/unslop/fixtures/`: golden slop per domain, 1 slop + 2 near-misses for every static rule (141 dev cases) and a 24-case holdout.
- `tools/memory/`: project memory in `.jstack/memory/entries/<id>.json` (decision, budget-rationale, known-slop, failure, convention, false-positive), anchored to `path#symbol` with a normalized body hash; `check` resolves FRESH / DRIFTED / MOVED / RENAMED / SPLIT / STALE through refactors and names the removing commit; `reanchor --auto` only for unique, confident moves; every write schema-checked and secret-scanned (`secrets.mjs`, also used by evidence and reports).
- `ready-gate.sh` checks 7-9: pre-flight with its tier's sections (`JSTACK_READY_PREFLIGHT`, warn), the unslop gate (`JSTACK_READY_UNSLOP`, warn; blocks only on rules that earned it), memory anchors in repos with `.jstack/memory` (`JSTACK_READY_MEMORY`, block). New settings `JSTACK_UNSLOP_MAX_AGENTS`, `JSTACK_UNSLOP_MAX_CANDIDATES`, `JSTACK_UNSLOP_GATE_SECONDS`.
- `/train`: the worker clause runs `/preflight` first and `/unslop` before READY; the orchestrator runs `gate.mjs --train` after the integration typecheck and drops the branch a hit names; every new Lesson also becomes a `failure` memory entry.

**Why:** a pass over a few months of agent work (1,036 of my messages, 2,571 subagent transcripts, 1,891 fix/perf/revert commits) sorted about 230 failure classes into 16 domains, and the root cause column almost never said "hard problem". It said "not asked before" (no budget, no oracle, no state machine, no commit point, no erasure line) or "not proven after" (self-certified READY, measured on the wrong build, a test never seen red). So: questions and numbers before the first edit, and after it a finder that has to prove every claim to a second agent before I see it. The scanner is held to its own standard: per-rule precision on fixtures and a holdout, field precision from rejected findings, and demotion when a rule stops earning its place. Its first run on jstack itself produced 26 hits, all false positives (the packs quoting their own patterns, `.slice(0, 10)` on dates and hashes), which is why the slice rule got narrowed and every rule starts in warn. Unverified: the 0.8/0.5 promotion and demotion thresholds (first guesses until real feedback exists), universal-ctags on Windows (the built-in symbol locator carries it alone), Linux/macOS. Not built yet: the seeded-app agentic eval, canary injection, the retro miner script, and the hook that denies hand edits of `.jstack/memory`. The 32 GB laptop notes this is the first feature in a while that never asked it for a build.

## 2026-10-25 (evening): cleanup by owner, forgotten browsers get closed, and hooks that can't crash a session

**What:**
- Cleanup now kills by ownership, not by worktree. New `hooks/jstack-calls.mjs` records every Bash/PowerShell call per agent (PreToolUse opens a window, a new PostToolUse hook closes it). Claude starts one shell per call as a direct child of the CLI, and a Bash shell's command line carries the command text, so each shell belongs to exactly one call; everything under it belongs to that agent. Processes whose launcher died count only when no other agent's call could have started them, and never the lock/RAM helpers. Unknown or ambiguous means nobody's.
- An agent that stops with its own background work in flight (the stop payload's `background_tasks`, or its background shells still alive) is paused, not done: nothing is cleaned until it stops with nothing in flight. Logged as `cleanup-skip`.
- New `hooks/jstack-browsers.mjs`: on SubagentStop/Stop, closes the Playwright/automation browsers the agent's own calls started (CDP `Browser.close` when there's a debugging port, else WM_CLOSE/SIGTERM, then the tree after 5 s). Only a browser with a debugging pipe/port on a non-default profile counts: your own Chrome and the Claude in Chrome browser are out of reach. Opt in per project with `"browsers": { "enabled": true }`.
- Keep one open on purpose: `jstack-guards.mjs keep-browser [pid] --reason "..."` writes `~/.jstack/keep-browser/<pid>` (the browser's or its launcher's pid); markers expire after 1 hour.
- `jstack-guards.mjs browser-watch` (`--install` for the Windows Startup folder, `"browsers": { "watch": true }` to switch it on): every 60 s, closes orphaned automation browsers and those of agents that already stopped, after a 10 min grace.
- `hooks/run-hook.mjs`: every hook goes through it. It imports the guards dynamically, so any crash, even a syntax error, exits 0 silently and logs a `hook-crash` line.
- `hook-report.mjs` shows waits, browser closures (and kept ones) and hook crashes.

**Why:** the old cleanup matched any process whose command line named the agent's worktree. It killed an agent's own `next build`, its `run-capped.ps1` and the RAM clean while the agent was only waiting on that background build (twice, and the build had to start over), and an Explore subagent that stopped took its parent's shells in the shared worktree down with it. Separately, an agent left a Playwright window open after it had seen what it needed, and the windows kept piling up. And a half-written hook file broke every Stop hook on the machine for a minute, because the plugin runs straight from the checkout. Measured on this machine: attribution by shell text picked the right agent in every live run; Chrome for Testing ignores WM_CLOSE, so pipe browsers end up force-closed after 5 s, while port browsers close cleanly over CDP. Unverified: Linux/macOS process groups. The 32 GB laptop would like it noted that it never asked for twelve tabs of "about:blank".

## 2026-10-25: the RAM clean runs itself, worktrees opt out with one command, and a night of train lessons

**What:**
- `tools/ram-clean.ps1` + `tools/setup-ram-clean.ps1` (Windows): register RAMMap `-Ew` once as an on-demand scheduled task with highest privileges (signature checked, battery limits off), then fire it with no UAC prompt. `mem_guard` fires it once per call when RAM is short and rechecks; `heavy_release`, `tc_run`, `worktree-deps` installs and `worktree-deps remove` fire it in the background; `ram-clean.ps1 -Watch` acts only while RAM is low or the system cache is huge AND real work runs. One cooldown for every trigger (`JSTACK_RAM_CLEAN_COOLDOWN_S`, 300 s), before/after numbers in `~/.jstack/ram-clean.log`, a silent no-op without the task. New settings `JSTACK_RAM_CLEAN_TASK` (`JstackRamClean`), `JSTACK_RAM_CLEAN_SETTLE_S`, `JSTACK_RAM_CLEAN_SKIP_ABOVE_PCT`.
- `worktree-deps.mjs own deps|generated` and `share deps|generated`: a worktree takes its own copy (reading the store, never writing it) and keeps it on later runs until it shares again; `status` shows the choice.
- `machine-memory`: step 3b is now the automatic clean; step 3c says share by default, own by choice, and adds Playwright, ORM engines, the test database, task-runner caches and env files to the measured table; the orchestrator frees the cache on a watch tick instead of asking, and starts no optional stack during a build. The pattern table carries the night's numbers (16 of 21 cache climbs had an install running, 0 a scan).
- `/train` lessons: migration timestamp collisions inside one train, conflicts with a train mate, a green deploy serving 500s (smoke-test touched URLs), merging when only irrelevant slow checks are pending plus job-level path filters, agents that go quiet without committing, and "the owner's OK is final".

**Why:** the file cache kept refilling to 10-16 GB and the only fix waited for a human to click UAC, sometimes all night. One clean took the system cache from 14.3 GB to 1.1 GB and available RAM from 2.7 to 16.8 GB in 5 s; it refills within a minute while installs run, which is why it fires after each install instead of once a day. The guards keep reading "available" (free + standby): the true free list sat at 0 to 1.3 GB the whole time and `-Ew` never raises it, so a free-list guard would never pass. The opt-out exists because the next `deps` run used to delete an own install to relink the store. Unverified: the watcher's thresholds are a first guess, and the per-trigger before/after numbers are still being collected. The 32 GB laptop has asked to be credited as a co-author.

## 2026-10-25: worktrees share their dependencies, and removing one no longer eats the store

**What:**
- `tools/worktree-deps.mjs`: `new-worktree.sh --install` now links `node_modules` (root and every workspace's) to a shared store, one per set of dependency inputs (dependency fields of every `package.json`, lockfiles, `bunfig.toml`, `.npmrc`, `patches/`), built once under a lock. Workspace packages always link to the worktree's own sources. A branch that changed a library gets its own install; generated code (`JSTACK_CODEGEN_REUSE_PATHS`) is shared the same way, keyed by the git trees of `JSTACK_CODEGEN_INPUTS`. Commands: `deps`, `generated`, `status`, `plan`, `detach`, `prune`, `remove`. Settings `JSTACK_SHARED_DEPS` (1) and `JSTACK_STORE_INSTALL_CMD`.
- `remove` unlinks every junction before `git worktree remove`; `clean-worktrees.sh` uses it. The guard hook now denies a bare `git worktree remove` and `robocopy ... /MIR` and points to it, and the install denial points to `worktree-deps.mjs deps`.
- `machine-memory` gets step 3c (share, don't copy: the rule, how it stays correct, a measured table of what each worktree holds and what to share or keep); the train skill and worker clause carry the hard rules.

**Why:** with about ten agents, every new worktree ran its own install: 167,019 files, 10 to 12 minutes, 4.6 to 5.7 GB more file cache each, and the cache sat at 10 to 16 GB. Linked, a new worktree takes 13 to 20 seconds and 27 MB of cache. Then the first cleanup test with `git worktree remove` (Git for Windows 2.40) walked straight through a junction and emptied part of the shared store; `robocopy /MIR` did the same in a test. `rd /s /q`, `rm -rf` and Node's `rmSync` don't. So removal has a helper and a hook now. Unverified: npm and pnpm layouts (only Bun's hoisted one ran), and Linux/macOS, where the junctions become plain symlinks. The 32 GB laptop says it hasn't felt this light since the day it was unboxed.

## 2026-10-25: guard hooks, a READY gate, and a report on whether either hurts

**What:**
- The jstack plugin now ships hooks (`hooks/hooks.json`, `hooks/jstack-guards.mjs`). They do nothing until `~/.jstack/guards.json` names your project (example in `tools/guards.example.json`), so only people who install jstack and write that file get them. Nothing goes in a repo's `.claude/settings.json`.
  - **heavy-lock** (PreToolUse, Bash and PowerShell): denies `tsc`, `tsgo`, `next build`, `run typecheck`/`build`, `turbo build` and `bun/npm/pnpm/yarn install` unless they go through `tc_run`, `heavy_capped` or `heavy_acquire`. The denial names the exact command to retry with.
  - **scan** (same hook): denies recursive `grep -r`, `find`, `du`, `ls -R`, `tree` and `Get-ChildItem -Recurse` over a repo root, a `.worktrees` folder, anything above the repo, or `node_modules`, and points to Grep/Glob, `git grep` or LSP. Scoped searches in a subfolder pass.
  - **cleanup** (SubagentStop; Stop only with `"onStop": true`): kills node, bun, bash, tail and friends whose command line names a worktree the agent used and that started after its first command. Never the main checkout, never older processes, never the Claude CLI.
- Every block is logged to `~/.jstack/guard-log.jsonl` with the agent, the command, the suggested retry, and whether the agent's next call took it. `tools/hook-report.mjs` (`jstack hook-report`) sums it up: blocks per day, agents blocked twice or more, ignored advice, cleanups.
- `tools/ready-gate.sh`: what the train checks before accepting READY. The tree is committed, the typecheck is green on that commit (via `tc_run`, cached per SHA), unit tests next to touched files pass, prettier passes on touched files, and `.agent/brief.md` has every item ticked. New settings `JSTACK_UNIT_TEST_CMD`, `JSTACK_PRETTIER_CHECK_CMD`, `JSTACK_READY_EXTRA_CMD`, `JSTACK_LOCK_SCRIPT`.
- `/train` gets section 6c (gate before boarding, brief checklist, daily hook report); the worker clause and orchestrator brief use the gate; `machine-memory` mentions the guards and the daily report.

**Why:** an audit of two days of agent work found 28 "done" claims with no proof, 21 typechecks and builds outside the lock (5 to 8 GB each), `grep -r` over 185 worktrees, and servers left running after their agents ended. The laptop sat at 0.2 to 3% free RAM and got rebooted. The rules were already in every brief. Agents skipped them anyway, so now a hook enforces them. The brief checklist stays a rule the gate reads, not a hook: a hook can't tell whether a brief item is done. The report exists because blocking an agent can also make it flail, and that should be a number, not a feeling. The 32 GB laptop has been asked for comment and is just happy to be in the room.

## 2026-10-25: the file cache that wouldn't leave, and one sweeper at a time

**What:**
- `machine-memory` gets step 3b: when the Windows file cache stays resident and won't trim, Sysinternals RAMMap `-Ew` empties it. Downloaded from live.sysinternals.com, signature checked, kept in the tools folder, run elevated only with the human there to click UAC. Plus: delete worktrees in small batches, `core.longpaths` or `robocopy /MIR` for "Filename too long", and prevention (remove on merge, one install at a time, an optional antivirus exclusion that's the human's call).
- `/train` section 6b: exactly one sweep owner at a time, and no sweep removes a worktree with untracked work or one touched in the last 2 hours. `clean-worktrees.sh` enforces both (a `-sweep` lock next to the heavy slot, idle default 60 to 120 min, build/scratch output ignored when checking untracked files) and removes with `core.longpaths=true`.
- New `/train-compound`: many ready branches pile up in one release branch, each boarding typechecked and deploy-checked, released only on the owner's word. Points at `/train`'s watch and hygiene sections, and warns that the release build may need the cache emptied first.
- `/optimize`: samples taken below 35% free RAM are invalid, and a deploy mid-measurement resets cold starts, so hold merges or throw that window away.

**Why:** the file cache sat at 16.8 GB after installs, antivirus scans and deleting worktrees out of a repo with about 368 of them. No process held it, so killing agents did nothing; RAMMap freed about 14 GB in seconds, twice. Separately, two cleanup sweeps ran at once and one removed worktrees the other had decided to keep. The 32 GB laptop has filed a complaint.

## 2026-10-24: the train cleans up after itself

**What:** `/train` gets a section 6b.
- Boarded worktrees are removed right after the merge, once they're clean and merged; the branches stay.
- After each release, a leftovers sweep checks seven things:
  - stale worktrees;
  - stray processes;
  - uncommitted work;
  - dangling READYs;
  - stopped containers;
  - temp builds;
  - held slots.
- The sweep removes what's provably done and lists the rest.

**Why:** one repo had 368 worktrees, 354 of them with their own `node_modules`. Every install and git sweep walked all of them, and the file cache paid for it in RAM. Agents end; their worktrees, servers and loops don't.

## 2026-10-24: mem-map, a machine-memory skill, and lock guards that wait for RAM

**What:**
- `tools/mem-map.ps1`, run as `mem_map` from `heavy-lock.sh` (Windows), shows:
  - totals: available, commit, standby, modified, pools, and how much of the "in use" memory is the system file cache;
  - process groups sorted by private bytes;
  - each process tagged with its worktree, branch and agent (`<worktree>/.agent`, the lock owner, the queue file);
  - the WSL VM and `docker stats`;
  - listening dev ports, orphan candidates and lock slots.
- `mem-map.ps1` options:
  - `-Kill orphans` terminates orphan candidates through WMI, never the agent CLI, MCP servers or Docker;
  - `-Watch` appends one CSV row per process per tick;
  - `-Summary` prints each agent's peak and when it happened.
- In `heavy-lock.sh`:
  - `heavy_acquire` waits for `JSTACK_HEAVY_MIN_AVAIL_GB` (12) free once it holds the slot.
  - `tc_run` waits while someone else's build holds the slot, starts at least 90 s after the other lane, then waits for `JSTACK_TC_MIN_AVAIL_GB` (10). A slot held from the same directory counts as yours, so the train can typecheck inside its own build slot.
  - Every wait gives up after `JSTACK_MEM_WAIT_MAX_MIN` (15) and runs anyway, still capped.
  - Owner lines end in `@ <cwd>`; the first word is still the name.
  - New `mem_guard [gb]` helper.
- New `skills/machine-memory/SKILL.md`; the train watch and worker clause point at it.

**Why:** the 32 GB laptop kept hitting 97 to 99% and nobody could say whose fault it was:
- Process lists sort by working set, so the 8 GB typecheck that was paged out looked tiny.
- Agents reported loops as stopped that were still running.
- `taskkill` sometimes refused, while WMI terminate worked.
- The biggest single spike wasn't a process at all: two concurrent installs over hundreds of `node_modules` folders kept 15.8 GB of file cache resident.

Claude Code has no per-subagent resource view, so the map tags each process by worktree. Also, `grep -iF` aborts (core dumped) in Git Bash here, so the lock compares strings in bash.

## 2026-10-25: jay-claude-switcher 0.9.0 shows its work, and won't settle for the 20x without looking

**What:** every swap decision now writes the ranking it used to `switch-trace.log`, one line per account: plan size, weekly status (`none`, `limited`, `unknown`), 5-hour and weekly %, whether it is free, and how old its reading is. Each load writes `start version=...`, so the trace says which code made which call. The trace is appended to instead of rewritten from each instance's memory, and every line carries an instance tag, so two sessions (or a reload) no longer wipe each other's history. And when the 99% switch is about to land on a weekly-limited account while some account's weekly status is unknown or stale, those accounts are read first (4 s cap) and the ranking redone.

**Why:** at 05:00 a team seat with no weekly limit hit 99% and the switcher picked the weekly-limited 20x, with two no-weekly team seats free, then moved to one of them 21 s later. The replay shows how the 0.8.0 code does exactly that: a seat with no reading yet (its usage read refused or not done after a reload) doesn't count as free, so the 20x at 0% was the only "free" one; once the seats read free, the better-account rule moved the session, as designed. The 20x lost 21 s of its weekly budget, which is the part of the plan we are trying hardest not to spend. Nobody could tell from the trace which code ran, because each instance rewrote the file from its own memory and a reload a minute later wiped it. The 32 GB laptop, as usual, was not consulted.

## 2026-10-24: jay-claude-switcher 0.8.0 is a load balancer: small accounts first, big ones saved

**What:** the switcher now picks accounts by priority instead of "least used". Accounts with no weekly limit go first (smallest plan first), then weekly-limited ones, smallest plan first (5x before 20x), the one with the most weekly headroom (then the soonest weekly reset) breaking ties. It swaps for exactly two reasons: a better-priority account frees up (its 5-hour window resets or drops under 98%, weekly not exhausted), and it swaps at once, even mid-use; or the current account runs out (99% on screen, or a 429), and it goes to the best free account. Nothing else swaps: no rebalancing because a same-class account has more room. Every account is read at session start, the others every 10 minutes and right after their reset, the new one right after a switch. The panel shows each account's weekly status ("no weekly limit" vs a bar), the next wake-up, and why the current account is the one in use. `priority.json` next to the store overrides the order. "No weekly limit" is read from the usage endpoint itself: it lists only the meters that apply, so no `weekly_all` row means no weekly limit, while a row at 0% is a limit with room.

**Why:** "least used" burned the 20x accounts as happily as the throwaway 5x ones, so the weekly-limited big plan hit its weekly wall midweek while unlimited team seats sat idle after their 5-hour reset. Now the small ones get cycled and the big one waits on the bench, and the moment a small one wakes up the session hops back to it. The 32 GB laptop approves of anything that spends less of the expensive stuff.

## 2026-10-24: jay-claude-switcher 0.7.0 switches within a second of 99%, not after the wall

**What:** the switch decides on the readings in hand and never waits for a usage read. Every second it reads the session's own rate-limit numbers (free; every response brings them, main loop, subagents and workflow agents alike) and switches within that second of a bar reaching 99%. From 95% the other accounts are read ahead, once per 5 minutes, so the target is known before it's needed; only when no account has a reading below 99% does a due switch read them, for 4 s at most. A usage answer can no longer lower the session's own (fresher) number for the same window. The new credentials are written first, before the bookkeeping. After a switch, readings that still carry only the old account's windows are not laid over the new one for 10 minutes. And there's a trace now: `switch-trace.log` next to the store, one timestamped line per reading, decision and switch, never a token.

**Why:** the stored usage samples showed the bar at 99% 16 s (and, another time, 44 s) before the first 429, and still no switch until after it. Nobody missed the 99%: the check saw it, then sat waiting behind network reads. From 95% the current account was read every 5 s, and the switch first awaited any read in flight, then read every other account one after another (token refresh included) before writing anything. Meanwhile a lagging usage answer could overwrite the 99% with 97% and call the switch off. A workflow of 13 agents climbs a point every 20 s or so near the top; the switch spent its whole margin on HTTP. The 32 GB laptop was idle the entire time, which for once was the problem.

## 2026-10-24: /optimize learns what a blank screen looks like

**What:** three new rows in `skills/optimize/DEBUG-CHECKS.md`: a screen change that blanks the whole UI (a pending check
drawn in place of the shell, plus a click that renders everything at once), a list that shows up seconds late on some
loads (half its data outside the server preload, a preload budget that drops misses, per-row queries), and local A/B
runs that all time out because the machine is swapping.

**Why:** two real cases from the same day. Opening a thread blanked the header, background and input for half a second
because an app check said "wait" by erasing the whole screen. The side list took up to 4.7 s because half of what it
reads was never preloaded. And the A/B to prove it couldn't run: 2 GB free out of 32. The laptop was, once again, the
bottleneck.

## 2026-10-24: /optimize puts "perceived instant" first

**What:** `skills/optimize/SKILL.md` gains a top-level section, "Perceived instant first", with five rules and the
check an agent runs for each: the shell never unmounts or blanks; anything not instant gets a skeleton in place; the
probable next action is kept warm (server preload, prefetch on render/idle/hover) and refreshed in the background;
cached state is drawn first and reconciled after; time-to-shell, first content and long tasks are measured on every
pass. Saying "this can't be faster" without adding a skeleton now counts as a failed run.

**Why:** the agent kept chasing total load time while the user stared at a side list that took seconds and a screen
that blanked on every thread open. Those were basic perception bugs, and the old skill would happily report "the query
is already fast, nothing to do" and leave the blank screen there. Fast-but-blank is still blank.

## 2026-10-23: /optimize starts from a checklist of what already went wrong

**What:** new `skills/optimize/DEBUG-CHECKS.md`, three tables (method traps, machine traps, known causes), every row
as symptom → how to measure → cause → proven fix → verify. It replaces the dated "What the runs learned" list in the
skill, adds a 1-run smoke of the suite before the baseline, and makes it a standing rule that every run turns each
finding into a row there and an entry in the playbook while it runs.

**Why:** an optimize run spent its first hour learning things earlier runs had already paid for: the suite's selectors
died with a UI redesign, a "click → done" metric finished before the click because the old screen already matched,
a popup ate every click, TBT went "up" because the page painted earlier, two builds at once took the laptop to 2% free
RAM, and six tries at decoding the server HTML with inline regexes. A dated list of anecdotes didn't stop any of it; a
checklist you run before measuring does. The 32 GB laptop thanks you in advance.

## 2026-10-23: jay-claude-switcher switches before the wall, not after it

**What:** the switch now acts on the number on screen: the moment a bar shows 99% (98.5% and up), the next 1-second check switches. To keep that number fresh, the rate-limit numbers are re-read after every response (main loop and every agent), and from 95% the current account's usage is read every 5 s instead of once a minute. After a limit error the status line names where the session went and who to resume (the main conversation and every agent whose turn ended on an error within two minutes). A stored account whose usage read comes back 401 is refreshed with its refresh token and the rotated pair saved; only a refused refresh (`invalid_grant`) marks it logged out, and token calls now send their own User-Agent because the endpoint's firewall refuses some clients' default one.

**Why:** version 0.5.0 did switch, but only after the limit hit, so the running agents died with 429 first and nobody told the owner which ones to wake up. The bar read 98 while the account was already at 99, because the numbers were only refreshed on the main loop and the account was read once a minute. Meanwhile one account showed as dead when it only needed its tokens refreshed (and one really was dead: its refresh token had been rotated by another session). 13 agents, one wall, zero survivors. Not anymore.

## 2026-10-23: jay-claude-switcher switches at 99%, and on the limit error itself

**What:** the auto-switch threshold drops from 99.9% to 99%, and it checks at once on every new reading. The session's own limit error (`StopFailure` with `rate_limit`, or any turn ending on an API error at 98% or more) now marks the account full and switches right away, with a 15 s pause instead of 90 s. A candidate whose last usage read got a 429 keeps its last reading instead of being ruled out; only an expired login rules an account out; with nothing readable below 99%, an account never read gets a try. When there is nowhere to go, the Sessions tab says why. New end-to-end tests drive the plugin through the test engine: crossing 99% switches, a limit error switches, no candidate writes nothing and shows the reason.

**Why:** the first live miss. The session's numbers sat at 99% (they are rounded) while the threshold waited for 99.9%, and the other accounts had just had their usage reads refused with 429, which silently ruled every one of them out. So the account hit the wall, the agents ate 429s, and the switch never moved. The 32 GB laptop was fine. The 13 agents were not.

## 2026-10-23: jay-claude-switcher, a second plugin for juggling Claude accounts

**What:** new plugin in `plugins/jay-claude-switcher/`, listed in the marketplace next to jstack (`/plugin install jay-claude-switcher --marketplace jayjayholic/jstack`). A side panel with a Sessions tab (every stored account, its 5-hour and weekly bars, sorted by nearest reset, Use and Refresh buttons) and an auto-switch that swaps `.credentials.json` to the least-used account when the current one reaches 99.9%. Plus a Work tab (limits with a forecast, running agents, tool calls in flight, task list, context window), `scripts/switch.py` (`save | list | use | next | import`, honours `CLAUDE_CONFIG_DIR`, writes the store owner-only) and an `add-account` skill that logs a new account in through a second Claude Code with its own config folder, so the working session never logs out. The usage endpoint is read only from 98%, at most once a minute, and backs off on 429 (Retry-After, else 5 minutes doubling to 30).

**Why:** 13 agents on one account hit the 5-hour wall at 3 a.m. and die mid-task, and switching accounts by hand means logging out the session they all run in. A running Claude Code re-reads `.credentials.json` when the file changes, so a file swap moves every agent to the next account on its next request. The 32 GB laptop was finally fine; now the rate limiter is too.

## 2026-10-23: /optimize gets a performance know-how file

**What:** new `skills/optimize/PERFORMANCE.md`, and `skills/optimize/SKILL.md` now reads it before measuring and gains a fifth rule, "explain the number". The file has the method (write the claim first, name the limiter, the performance mantras cheapest first, one change and one measurement with a decision log, ABAB with rank statistics, keep behaviour), a 7-question check every number must pass before it's reported, the metric targets (including SPA soft navigations, on by default since Chrome 151), trace recipes per layer that turn every capture into SQL rows (Perfetto, LoAF, web-vitals attribution, React Performance Tracks, `--cpu-prof`, Server-Timing, OpenTelemetry, ORM spans, pg_stat_statements), techniques for instant screens and chat, cases with numbers, how the old rules (Souders, RAIL, PRPL) aged, and every source with its date. The method is adapted from Lauren Tan's [pstack](https://github.com/cursor/plugins/tree/main/pstack) (MIT) and Brendan Gregg's Benchmarking Checklist and USE method, with credit in the file.

**Why:** /optimize knew how to run an A/B, but not how to tell a real number from a fake one. A fix can look faster because the request errored, the cache was warm on one side, the work never ran, or the change saved more time than the code it touched ever took. The research behind this was two separate arms, one agent on primary sources and one research agent, then merged. They disagreed in useful places: clinic.js is no longer maintained, TanStack's `prefetchQuery` is deprecated, and the famous "Amazon 100 ms = 1%" line isn't on the page everyone cites. So it's in here as unverified, not as fact. Also, an agent that knows "don't do it" comes before "do it cheaper" is one fewer `next build` on the 32 GB laptop.

## 2026-10-22: real reds, out-of-memory deploys and one big train

**What:** four new lessons in `skills/train/SKILL.md`. Read every failing line before calling it a flake, and bisect against the previous merges when unsure. When the host build dies with "Killed / exit 137" after an account or billing switch, measure peak memory with one capped local build, then check the host's build machine size through its API (Vercel: `resourceConfig.buildMachineType`) and only change it with the owner's go, since it hits the bill. When the host was blocked, board every waiting ready branch into ONE big train, drop the conflicting ones, ship the rest. And workers never start their own app servers: component gallery and test scripts, one shared server at most.

**Why:** a train merged on a real red because half its failures were dismissed as "worktree state" (one was a real test mock regression). A deploy kept dying out of memory while local builds were green, because the build machine had silently dropped back to standard 8 GB and the build needs about 9.8 GB. A pile of ready branches was about to crawl through many small trains. And a handful of per-worker app servers plus typechecks took the 32 GB laptop down to 2% free RAM.

## 2026-10-22: when GitHub is degraded and the deploy goes quiet

**What:** three new lessons in `skills/train/SKILL.md`. Missing host statuses during a GitHub incident get ONE check with the host CLI (`vercel ls`), never a loop. If no deploy appears about 10 min after a merge, deploy the target branch by hand from a clean `git archive` export (link, delete the pulled `.env.local`, deploy to the env, delete the scratch dir). And editing a file through the GitHub contents API from Git Bash on Windows: build the content from `git show`, base64 it from a file, diff before merging.

**Why:** during a GitHub incident the deploy statuses disappeared while deploys kept running, and another merge got no deploy at all because the webhook never fired. Watching it with a CLI loop once grew to 4 GB. And `jq -r .content | base64 -d` broke on `\r\n` and committed a truncated file without a word of complaint.

## 2026-10-22: what the train does when GitHub Actions won't run

**What:** a new lesson in `skills/train/SKILL.md`: when Actions won't start jobs (credits, billing, spending limit), the train runs the same checks locally (merge-strategy guard, Prettier on changed files, typecheck, unit suites under `heavy_capped`), merges with `gh pr merge --admin` only if all are green, writes the results in the PR body, and confirms the deploy from the commit statuses. Actions-only jobs wait.

**Why:** the credits ran out mid-night and every check failed in 2 s without running anything. The train stood still on a red that wasn't a test result, while the checks it needed are a handful of commands the laptop can run on its own.

## 2026-10-22: copy fix in new-worktree.sh

**What:** reused generated folders and copied local folders are now replaced, not copied into themselves.

**Why:** when the target folder already existed, `cp -r` dropped the copy inside it (`.generated/.generated`), and the agent's typecheck failed on missing generated code.

## 2026-10-22: the numbers, and worktree cleanup

**What:** a short numbers section in the README with a monthly chart GitHub draws itself, and `tools/clean-worktrees.sh`, which removes finished worktrees only when the branch is merged, nothing is uncommitted, nothing runs inside and nothing changed in the last hour.

**Why:** people asked if it actually works. And one night of parallel agents left 275 worktrees on the disk.

## 2026-10-22: the planning skills ship with jstack

**What:** `/grill-me`, `/grilling` and `/wayfinder` (plus the four skills wayfinder calls) are now in `skills/`, copied as-is from [mattpocock/skills](https://github.com/mattpocock/skills) (MIT, licence file in each folder), so `/plugin install` brings them too. `/simplify` gets `skills/simplify/README.md` instead of a copy: it's built into Claude Code and its licence doesn't allow redistributing it, and you already have it anyway. README, HOW-I-WORK.md and AGENTS.md now point at the in-repo copies.

**Why:** the README says plan first, but the planning skills lived in another repo, so people had to install things separately before jstack even made sense. Now it's one install. `/wayfinder` calls Matt's `research`, `prototype` and `domain-modeling` skills and expects an issue tracker set up with his `setup-matt-pocock-skills`, so those four are copied as-is too (same pin, same MIT licence). Nothing else to install.

## 2026-10-22: README says who this is for, and what plan to bring

**What:** a new section near the top of the README: jstack is for detailed, planned and prototyped work (grill the plan, map it with /wayfinder into tickets with dependencies and owned files, prototype the UI, then start the agents), and a recommendation for a Claude Max 20x plan or equivalent high limits.

**Why:** the dependency graph from planning is what makes one agent per chain work. The night the latest rules came from, the planned and prototyped UI flowed while the process changes improvised live cost rework. And with 10 to 13 agents at once, lower limits killed agents mid-task, and each one had to be resumed by hand.

## 2026-10-22: typecheck lane, drop don't fix, chains, and "measure it"

**What:**
- `tc_run "<cmd>"` in `heavy-lock.sh`: a typecheck lane for worker agents, `JSTACK_TC_SLOTS` parallel slots (default 2), each run capped at `JSTACK_TC_CAP_GB` (default 8), separate from the train's heavy slot.
- READY now ends with `typecheck green at <sha>`. New `train.sh board <wt>@<sha>` adds branches to the boarding train (continuous boarding) and refuses a head that moved past that sha.
- The train is a quick merge: one incremental integration typecheck, and a failing branch is dropped and bounced with its errors, never fixed in place or waited on. The boarding train is assembled and typechecked while the other is in CI. Big trains run CI's suites locally before the push. The formatter runs in write mode, resolutions chain their check with `&&`, nobody commits in a worker's live worktree, and bounced branches get a `train/<date>-<n>-wip` base.
- `new-worktree.sh` only reuses generated code from a sibling where every path in the new `JSTACK_CODEGEN_REQUIRED` exists and is non-empty, and checks the copy again, falling back to codegen if it's incomplete.
- The train skill: one agent per dependency chain, gates written before work starts, a bigger watch (orphaned scripts, only `running` agents count, frozen rules, commit as you go), a new section 7 "Measure it" (Little's law and the clean-batch probability), and lessons for deploy-only failures (anchor `.vercelignore` paths), the pre-push hook and rule churn.
- README, ADAPT.md, AGENTS.md, llms.txt and the plugin manifest (0.5.0) follow.

**Why:** after the first batch of rules, 27% of branches still broke the train's typecheck, because agents skipped it and the orchestrator fixed their errors one by one. At that rate a train of 8 is clean 8% of the time. Four parallel typechecks took the laptop to 0.3 GB free, so the lane is capped at two. A reused generated folder copied mid-codegen failed a train with 80 errors. An unanchored `docs/` in `.vercelignore` broke a deploy that every local check called green. And one agent per ticket kept agents waiting on each other: one agent per chain took merged throughput from about 3 to about 27 tickets an hour in one night (part of that was a backlog landing together). Little's law then showed about 20 tickets in flight where 4 would do, so the fix was starting less, not adding agents.

## 2026-10-22: hard RAM ceiling, agents never build, /train-queue

**What:**
- `heavy_capped "<cmd>"` in `heavy-lock.sh` runs a build or typecheck with a hard RAM ceiling on its whole process tree (`JSTACK_CAP_GB`, default 12). On Windows it's a Job Object through the new `tools/run-capped.ps1` (tested: a 1 GB cap stops a runaway allocation at 1 GB). On Linux it uses `systemd-run --user --scope -p MemoryMax`, UNVERIFIED. On macOS it runs uncapped and says so. `coordinator-build.sh` and the train's typecheck use it.
- `JSTACK_BUILD_ENV` passes env to capped builds, mainly to cap the build tool's workers (`CIRCLE_NODE_TOTAL=5` makes Next.js use 4 instead of CPU count minus 1).
- `JSTACK_TRAIN_BUILD=deploy`: the train only typechecks, and the integration deploy is the build check. A local build happens once, capped, only to reproduce a failed deploy.
- Workers never build. Screenshots go on a component gallery (`{{GALLERY_CMD}}`), live tests on the integration deploy, and the full typecheck lives in the train.
- Only builds and typechecks take the slot. `train.sh` takes it for a push only while a pre-push hook exists, and the docs suggest deleting a hook that repeats CI.
- Max two trains: one in CI, one boarding.
- New `/train-queue` skill: a read-only board of what's live, the train in flight, the queue and each agent's job. The orchestrator keeps the queue file (`{{QUEUE_FILE}}`) it reads.
- `new-worktree.sh --install` copies generated code from a sibling worktree when the codegen inputs match (`JSTACK_CODEGEN_INPUTS`, `JSTACK_CODEGEN_REUSE_PATHS`). Each worktree stamps the inputs its code came from, so a sibling whose schema moved after its codegen is never copied.
- The watch (section 6 of the train skill): kill the heaviest process tree below 5% free RAM, never the agent CLI; agents silent for over 60 minutes are suspects; servers left behind by finished agents get killed. `node-memory-watch.ps1` got `-Protect` (default `claude`) so it never kills the agent CLI, and a 95% default.
- README, ADAPT.md, AGENTS.md, llms.txt and the plugin manifest (0.4.0) cover all of the above.

**Why:** with the one-slot rule in place, a single `next build` still took the laptop to 2% free RAM: 19 workers at 0.75 GB each. `NODE_OPTIONS` caps one heap, not a tree, so the only real fix was a ceiling on the whole tree plus fewer workers. Then agents ran about 15 production builds in one night just to take screenshots, and held the slot for screenshot runs and proofs, so trains waited half an hour behind a screenshot. Four trains queued at once tripled the CI runs. And every new worktree regenerated the same ORM client from the same schema. Each rule here is one of those nights, made boring.

## 2026-10-22: findable and installable as a Claude Code plugin

**What:** a Claude Code plugin marketplace (`.claude-plugin/marketplace.json` + `plugin.json`, checked with `claude plugin validate`), so `/plugin marketplace add jayjayholic/jstack` and `/plugin install jstack@jstack` work. When installed that way the skills read `~/.jstack/config.sh` for anything still in placeholders. New `AGENTS.md` (notes for coding agents, per agents.md) and `llms.txt` (a short doc index, per llmstxt.org). The README now says in its first lines what this is and who it's for, with the install lines and a few badges. Skill descriptions name the things people actually search for (parallel agents, git worktrees, merge train, out-of-RAM builds, LCP/INP/TTFB). The GitHub repo got a description and topics. `.gitattributes` keeps the scripts LF on Windows checkouts.

**Why:** the popular skill repos all install with one `/plugin` line and say what they are in the first sentence. jstack opened with my life story. Agents looking for "parallel agents" or "worktree" skills had no way to find it, and the ones that did had to copy files by hand.

## 2026-10-22: the /optimize skill and HOW-I-WORK.md

**What:** published `skills/optimize/`, my speed agent. It measures the built app and staging (load time, LCP, INP, TTFB, long tasks, the API waterfall, bundle size), ranks what costs the user the most time, fixes the top items and proves each fix with interleaved A/B runs and real statistics. Same placeholder treatment as the train, with its own section in ADAPT.md, including what the perf scripts need to do if your repo doesn't have them yet. Also added `HOW-I-WORK.md`: the workflow before the train (grilled plans, two-arm research, prototypes, A/B everything, debugging from traces, /simplify), with real examples.

**Why:** people asked what happens before a branch is "ready". And /optimize is the skill I'd miss most after /train. Identical code once showed a fake 140 ms "win" between two runs on my laptop, so it insists on numbers and interleaved runs.

## 2026-10-22: works on your machine now, not just mine

**What:** every machine-specific value is gone from the scripts and the skill. The scripts read env vars with defaults from `tools/jstack-env.sh`, and you set yours once in `~/.jstack/config.sh` (template in `tools/config.example.sh`). The skill files use `{{PLACEHOLDERS}}` instead of my paths, branch and commands, and the rules that only made sense in my own repo became generic ones. New `ADAPT.md` walks a coding agent (or you) through detecting the stack, filling every value, installing, wiring the briefs and checking it all works. The free RAM check now works on Linux and macOS too. `train.sh` waits for the PR checks and only merges when none failed, and it typechecks and pushes inside the heavy slot like the Lessons say. The repo moved to github.com/jayjayholic/jstack, so the links point there.

**Why:** the old way was "find my paths and change them", spread over five files, and the skill still talked about my repo's folders. Nobody should have to read my scripts line by line to try this. Also the Lessons said "merge only on zero failed checks" while the script didn't check. That's embarrassing, so now it does.

## 2026-10-21: worktree script and the memory bouncer

**What:** added `tools/new-worktree.sh` (one worktree per agent, copies the local env files git doesn't carry) and `tools/node-memory-watch.ps1` (when RAM hits 98%, it kills the fattest node or bun process over 5 GB).

**Why:** the train only works if every agent has its own worktree, and people asked how mine get created. The watcher is there because before the one-slot rule my laptop froze hard enough to wipe `.git/config`. It's the seatbelt, the lock is the brakes.

## 2026-10-21: README, clearer quickstart and structure

**What:** the README now starts with a short version of the idea, has a diagram of how a train moves, a quickstart (clone, install the skill, copy the tools, brief the agents, use the lock), a table of every path and setting you need to change for your machine, a note on when not to use a train, and a small FAQ. Same facts, same machine table, same file map and Lessons, written the way I'd explain it out loud.

**Why:** the first version explained the problem well but never said how to install anything, and "paths in the scripts are mine, change them" didn't say which ones. Anyone trying it had to read every script to find out.

## 2026-10-21: first public version, the /train skill

**What:** the `/train` skill (`skills/train/`), the shared heavy job lock (`tools/heavy-lock.sh`), the capped build runner and the train script.

**Why:** shipping around 40 parallel agent branches in a day through one PR per branch meant dozens of full builds and CI runs, constant conflicts, and a laptop that kept crashing. Trains check many branches with one build and one PR.

**Fixed along the way (all in SKILL.md, under Lessons):**
- One machine-wide heavy slot instead of separate locks for the train and the agents. Three parallel Turbopack builds crashed the PC twice.
- Typechecks and `git push` count as heavy too. A 4.9 GB `tsc` ran next to a build and free RAM hit 1.3 GB.
- `server_wait`: no `next start` while a build runs or below 8 GB free.
- Stale slot timeout went from 15 to 45 minutes, plus a race when the owner file vanished mid-check.
- Merge only with zero failed checks, poll deploys through the GitHub API instead of the Vercel CLI, check for late GitHub webhooks, never `git stash`, and recover a wiped `.git/config` after a crash.
