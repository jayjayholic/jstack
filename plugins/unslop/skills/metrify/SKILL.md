---
name: metrify
description: "Use when someone types /unslop:metrify or asks whether /unslop is working, whether the same slop keeps coming back, which rules or pre-flight questions earn their place, or how long fixes take. Builds a local dashboard from the before/after record every /unslop run leaves in .jstack/metrics/runs/."
---

# /unslop:metrify: does the slop stop coming back?

Every `/unslop` run already writes its record: `report.mjs` calls `metrics.mjs record` (counts per domain and rule before and after, fingerprints, time from CONFIRMED to VERIFIED, verdicts given on the run, budgets met or missed, which pre-flight questions would have caught each finding and whether `.agent/preflight.md` asked them). Nothing to remember; for an older run without one, `node {{JSTACK_TOOLS}}/unslop/metrics.mjs record <run-dir> --scope <scope>`.

1. `node {{JSTACK_TOOLS}}/unslop/metrify.mjs` writes `.jstack/local/site/metrify/index.html`. Open it for the human.
2. Read it out in at most three lines, from the page, not from memory:
   - the trend: confirmed findings per run, and which domains went down or up (later half of the runs vs earlier half);
   - the top recurring slop: fingerprints seen again after a fix. Each is a candidate for a new rule or a pre-flight question (`/unslop learn` or `/unslop:retro`);
   - the levers: rules with a high false-positive rate (demote or narrow them), and pre-flight questions that would have caught findings but were "not asked" (make them part of the tier, or ask them next time).
3. With fewer than 4 runs say so: the halves are too small to call a trend.

`metrics.mjs show --json` gives the same numbers for a script. Records are committed (`.jstack/metrics/runs/`, one file per run, no merge conflicts); the page is local.
