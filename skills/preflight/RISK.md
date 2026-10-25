# Risk tiers

Score each axis 0, 1 or 2 and add them up. Tier **S** is 0-3, **M** is 4-7, **L** is 8 or more. A 2 on irreversibility or on security forces at least **M**, whatever the total.

| Axis | 0 | 1 | 2 |
|---|---|---|---|
| Blast radius | one file, a leaf | one feature area | a shared contract, schema, auth, the build, many callers |
| Irreversibility | local and revertable | data written, a flag needed | a migration, an outward send, a deploy order, deletes |
| User-facing | none | a changed screen or text | a new screen, a new flow, a brand surface |
| Novelty | memory has decisions here | partly known | nothing known; a new dependency or protocol |
| Cost / resources | none | paid calls or a heavy job | paid calls per item, fan-out, long-running work |
| Security / privacy | none | reads user data | writes user data, permissions, tokens, tenants |

`classify.mjs` prints a tier hint from the words it saw. It is a hint: you score the axes.

## What each tier asks

| Tier | Questions | Extra | Time box |
|---|---|---|---|
| S | MUST questions of the chosen packs, at most 5 | none | about 3 min |
| M | MUST + SHOULD | budgets for every touched surface, a verification plan | about 15 min |
| L | all questions | pre-mortem, FMEA table per pipeline or state machine, `/grill-me`, `/prototype` for UI | about 45 min + grilling |

## Worked examples

| Task | Scores (blast, irrev, user, novelty, cost, security) | Tier |
|---|---|---|
| Fix a typo in a button label | 0, 0, 1, 0, 0, 0 = 1 | S |
| Add a paged list endpoint that reads the user's own items | 1, 0, 1, 1, 0, 1 = 4 | M |
| Retry failed webhook deliveries with a background queue | 1, 1, 0, 1, 1, 1 = 5 | M |
| Add a column and backfill it for every row | 2, 2, 0, 1, 1, 1 = 7 | M (forced at least M by irreversibility anyway) |
| New sign-up flow with email verification and a new auth provider | 2, 2, 2, 2, 1, 2 = 11 | L |
| Per-document model calls during ingestion of uploaded archives | 2, 1, 0, 2, 2, 1 = 8 | L |

## Calibration

Tiers are a starting point. When `/unslop retro` shows that most escapes came from tasks tiered S, the thresholds are too lax for this project: lower them in the project's notes (a `convention` memory entry) and say so in the next pre-flights.
