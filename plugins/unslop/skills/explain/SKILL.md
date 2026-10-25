---
name: explain
description: "Use when someone types /unslop:explain or asks why /unslop flagged or fixed something. Builds a local static page for a run: each finding with when it came in, the failure it causes, the technique that applies with its cited source, before/after evidence and project research notes; records the human's verdicts and preferences so later pages and rule thresholds follow them."
---

# /unslop:explain: what was wrong, and why it matters

Tools: `{{JSTACK_TOOLS}}/unslop/explain.mjs` (jstack). Runs live in `.jstack/unslop/runs/`.

1. **Build.** `node {{JSTACK_TOOLS}}/unslop/explain.mjs build` (the latest run; `--run <dir>` for another). It writes `.jstack/local/site/explain/index.html`: per confirmed finding the place, `git blame` at the evidence commit (when it came in), the failure scenario, how it was proved, the fix direction, the pre-flight questions that catch it, the best-matching lines from the pack's `SOURCES.md` (matched by keywords, and the page says so), the before and after evidence, and your verdicts. Ruled-out candidates get one line each with the skeptic's reason. Open the page for the human.
2. **Research, when it helps.** If a finding's technique is thin for this project (no source matched, or the human asks "why does this matter here?"), research it with primary sources (the `research` skill, or the pack's sources opened and read), then write a short note to `.jstack/local/explain/notes/<rule-id>.md`: what applies to this codebase, each claim with its link, unverified claims marked. Rebuild. Never quote a source you didn't open.
3. **Listen.** When the human reacts, record it, then rebuild:
   - a finding is right or wrong: `explain.mjs feedback <run-dir> <finding> --verdict accepted|rejected --why "..."` (a rejection needs a reason). Verdicts go to `.jstack/local/feedback.jsonl`, which moves the rule's threshold: a rule rejected often drops to a review-agent hint, one accepted often earns the right to block (see `skills/unslop/SELF-EVAL.md`).
   - how they want it explained: `explain.mjs prefer --level short|full`, `--mute <rule,...>` / `--unmute <rule>`, `--note "I know idempotency; keep it to the fix"`. Preferences are `preference` entries in project memory, so every later page (and every teammate's) follows them.
4. Say in one line what changed ("muted perf.transition-all; empty-catch now 3 accepted, 1 rejected").

The page reads only local files and redacts secrets before showing anything. It never edits code.
