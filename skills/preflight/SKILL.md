---
name: preflight
description: "Use before writing code for any task (/preflight, or as the first step of a train worker): quote the ask, tier the risk, pick the domain packs, read project memory, answer the questions, write budgets, runnable acceptance checks and a scope fence into .agent/preflight.md."
---

# Pre-flight: think it through before the first edit

Almost everything that had to be fixed later was something nobody asked before: no budget, no oracle, no state machine, no reference image, no erasure line, no commit point. Pre-flight writes down **what must be true** (budgets, acceptance checks, scope, verification plan) and never **how** to build it. You stay free to design inside a fence you can test against.

Output: `<worktree>/.agent/preflight.md` (untracked, from [TEMPLATE.md](TEMPLATE.md)) plus `- [ ]` lines appended to `.agent/brief.md`, which `ready-gate.sh` already refuses to pass while unticked. Time box: tier S about 3 minutes, M 15, L 45 plus whatever `/grill-me` and prototypes take.

Tools live in `{{JSTACK_TOOLS}}` (the jstack `tools/` folder). Without a project memory (`.jstack/` missing) everything still works; say "no project memory" in the file.

## Steps

1. **Quote the ask.** Copy the request verbatim. Split it into items and tag each DIRECTIVE, QUESTION or INFO. A QUESTION gets an answer, never a state change. List what is explicitly NOT requested.
2. **Tier the risk** with [RISK.md](RISK.md). Write the tier and its one reason in one line.
3. **Pick domains.** `node {{JSTACK_TOOLS}}/unslop/classify.mjs --task "<ask>" --paths <planned files>` prints the packs with reasons and a tier hint. Add or drop a domain with a reason. Load each chosen `eng-<domain>` skill.
4. **Read memory.** `node {{JSTACK_TOOLS}}/memory/memory.mjs query --paths <planned files> --domains <list>` returns decisions, budget reasons, open known slop and past failures anchored in or near those files, each with its anchor status. A STALE or DRIFTED entry is a question, not a fact: re-read the code before leaning on it. A `decision` entry is binding until the human changes it.
5. **Answer the questions in writing.** Tier S: the MUST questions of the chosen packs, at most 5 in total. Tier M: MUST + SHOULD. Tier L: all of them, plus a 5-line pre-mortem ("it shipped and was reverted a week later; why?") and a small FMEA table (failure mode, effect, how we would detect it, severity) for each pipeline or state machine touched. An answer that needs a number gets a number, or "unknown, measure first", which becomes the first task.
6. **Write acceptance checks as runnable checks.** Each one: a command or a procedure, the environment (built app, stage, isolated test database), and the pass threshold. They are written before code, so the code is tested against them and not the other way round.
7. **Write budgets.** For each chosen domain, the keys that apply (`memory.mjs budgets` prints the project file merged over the pack defaults) plus new ones the task needs. A budget with no way to measure it is not a budget.
8. **Write the verification plan.** Which pack verify steps run, in what order, with which tool, and the decision rule for any A/B, written now, before the numbers exist.
9. **Write the scope fence.** OWNED paths, FORBIDDEN paths (from the ask and from memory decisions), outward or irreversible actions and who approves each, the rollback.
10. **Hand off.** Append every acceptance check and verify step to `.agent/brief.md` as `- [ ]` lines. Tier L: suggest `/grill-me` before code, `/prototype` for UI, `/wayfinder` for multi-session work.

Done when `preflight.md` has every section its tier needs, every budget has a method, every check is runnable, and `brief.md` has the lines.

## Rules

- Questions, budgets and checks only. No implementation plan beyond the order of verification. If you catch yourself writing code in the pre-flight, stop.
- Don't pad tier S. Two good answers beat ten boilerplate ones; "n/a" with a reason is fine.
- Never invent a number to fill a budget. "Unknown, measure first" is a valid answer and turns into the first task.
- A project question in `.jstack/unslop.json` (`extraQuestions`) counts like a pack question of its tier.
- When the task changes halfway, update the pre-flight first (new tier, new checks), then the code.
- When `/unslop` later confirms a slop that a question here should have caught, `/unslop learn` proposes that question. Every late fix becomes an early question.
