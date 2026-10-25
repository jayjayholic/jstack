---
name: retro
description: "Use when someone types /unslop:retro or asks what keeps breaking, which bugs escaped review, or which pre-flight questions or rules are missing. Mines recent fix commits and agent transcripts into clusters by domain, with escape metrics and draft questions and rules for the human to accept."
---

# /unslop:retro: what escaped, and what would have caught it

1. `node {{JSTACK_TOOLS}}/unslop/mine.mjs --since 14.days` (add `--transcripts <session.jsonl or folder>` for agent sessions; a folder is read one level deep). It prints the late-fix ratio (fix over feature commits), escapes per domain, the median days from a change to the fix that touched the same file, and per cluster its top words and files. Drafts land in `.jstack/local/retro/<date>.json`.
2. For each cluster with a draft, show the human the draft question and rule next to two or three of its escapes. Ask once which to keep.
3. Kept, generic: add the question or rule to its pack's `checks.json` with fixtures (1 slop + 2 near-misses) and open a PR upstream. Kept, project-only: `extraQuestions` / `extraRules` in `.jstack/unslop.json`, in its own reviewed PR (a branch that edits that file is a gate hit by design).
4. Clusters already covered by memory are listed with the entry ids: check whether the entry's guard test still runs.

No model calls; transcripts contribute 200-character redacted gists of the human's own bug reports, never tool output.
