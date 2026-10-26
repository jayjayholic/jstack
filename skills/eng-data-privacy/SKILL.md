---
name: eng-data-privacy
description: "Use when a change touches migrations, schema, personal data, erasure, tenant isolation, ACLs, provenance of stored content, or undo of merges. Immutable history, idempotent DDL, every person table in the erasure plan."
---

# Data model, migrations and privacy: think before, prove after

Applied migration history is immutable, every new table that holds a person's data joins the erasure plan in the same change, and nothing is stored that the user did not see or own. Schema changes go expand then contract, DDL is safe to re-run, and access can only shrink when data merges (a private fact never turns public). Destructive database commands never run against a shared database.

## How this pack is used

- **Before** (`/preflight`): answer the questions for the task's tier (S: MUST, M: + SHOULD, L: all + a pre-mortem). An answer that needs a number gets a number or "unknown, measure first". Copy the budgets that apply into the pre-flight with how each is measured.
- **After** (`/unslop`): the static red flags run in `tools/unslop/scan.mjs`; the review agent reads the diff for the `eyes` ones. A red flag is a hypothesis until a confirm recipe produces evidence that a second agent reproduces.
- **Machine part**: `checks.json` in this folder (triggers, questions, budgets, rules, verify). Projects tune it in `.jstack/unslop.json` (rule modes, waivers, extra questions and rules).

<!-- checks:begin (generated from checks.json by tools/unslop/packs.mjs; edit checks.json, then render) -->

## Pre-flight questions

**MUST (asked at every tier)**

- `data.q.new-migration` Is this a new migration with a unique stamp later than the base branch's newest, touching no applied migration? Is every statement re-runnable? _(answer as: text; prevents: edited-migration, stamp-collision)_
- `data.q.erasure-line` Does any new table or column hold or link to a person? Where is its erasure line (delete, anonymize, or retain with a reason)? _(answer as: table; prevents: erasure-gap)_

**SHOULD (tier M and L)**

- `data.q.which-script` Which project script applies this to each database (test, eval, dev, prod), and what host will it actually hit? _(answer as: text; prevents: destructive-shortcut)_
- `data.q.provenance` What is the provenance class of every piece of content this saves (user-authored, user's app, user-viewed, agent-fetched)? Did the user see it? _(answer as: table; prevents: foreign-content-saved)_
- `data.q.bind-by-id` Are resources bound by id and owner, never by a matching name? _(answer as: text; prevents: confused-deputy)_
- `data.q.scope-missing` What tenant or scope does each read and write resolve to server-side? What happens when it is missing (deny)? _(answer as: text; prevents: tenant-leak)_

**DEEP (tier L, with the pre-mortem)**

- `data.q.abuse-cases` Which abuse cases apply: domainless user, public-mail domain, uninvited same-domain user, group participant, other-org member? _(answer as: table; prevents: onboarding-leak)_
- `data.q.inverse` For every combining or destructive operation: where is the inverse, and what state must be stored now to run it later? _(answer as: text; prevents: irreversible-merge)_
- `data.q.acl-combine` How do ACLs combine? Can any step make a reader set grow without a new granting source? Pre-mortem: six months later a stranger saw our data; how? _(answer as: text; prevents: acl-widening)_

## Budgets

Defaults with their source. The project file `.jstack/budgets.json` wins; `null` means the project sets it the first time a task touches it (pre-flight turns that into a measure-first task).

| key | default | unit | how measured | source |
|---|---|---|---|---|
| `data.unmapped_person_tables` | 0 | count | schema-to-erasure-registry conformance test | GDPR Art. 17/30; LGPD Art. 18/37 |
| `data.edited_applied_migrations` | 0 | count | git diff --name-status <base>... -- <migrations> shows only A | Prisma migration histories; Flyway validate |
| `data.cross_tenant_reads` | 0 | count | authorization matrix test, forbidden cells returning data | OWASP A01 Broken Access Control |

## Red flags

A red flag is a hypothesis. /unslop turns it into a finding only with evidence (see Confirm recipes).

| id | what it looks like | why it is slop | detector | severity |
|---|---|---|---|---|
| `data.migration-edited` | Applied migration edited, renamed or deleted | Databases that already ran it keep the old version; checksums fail or schemas drift. | static `data.migration-edited` (script migration-edited) | high |
| `data.migration-stamp-dup` | Two migrations share a timestamp | Order between them is undefined; one can be skipped on databases that already ran the other. | static `data.migration-stamp-dup` (script migration-stamp-dup) | high |
| `data.ddl-not-idempotent` | DDL without IF NOT EXISTS (not safe to re-run) | A migration that fails halfway fails again on retry. | static `data.ddl-not-idempotent` (regex) | low |
| `data.destructive-db-command` | Destructive database shortcut (accept-data-loss, migrate reset, DROP DATABASE) | One wrong env file and it wipes a shared database; it also leaves no migration history. | static `data.destructive-db-command` (regex) | high |
| `data.person-table-no-erasure` | New table with user_id/email/author_id while the erasure module is untouched | Deleting an account leaves rows behind. | review agent (eyes) | high |
| `data.save-without-provenance` | Save/ingest of content that came from fetch, a browser or web search, or with no provenance argument | Agent-fetched content poisons the user's store and carries injected instructions. | review agent (eyes) | high |
| `data.lookup-by-name` | Owner-scoped resource chosen by display name | A name match picks someone else's resource. | review agent (eyes) | high |
| `data.acl-overwrite` | ACL assigned or spread in merge code instead of a lattice join | A private fact turns public after a merge. | review agent (eyes) | high |
| `data.no-inverse` | Merge/delete/move with no paired inverse and no stored pre-image | Undo is impossible or reconstructs the wrong state. | review agent (eyes) | medium |
| `data.edit-skips-review` | Content that passed a review, scan or ACL check when it was shared can be edited afterwards without that check running again | The audience receives the edited text, including what the review had removed. | review agent (eyes) | high |

## Confirm recipes

- `data.migration-edited`: static-proof: git diff --name-status shows M/D/R on a migration that exists on the base Fix direction: restore the file; add a new migration.
- `data.migration-stamp-dup`: static-proof: two entries with the same stamp prefix Fix direction: renumber the newer one after rebasing on the base.
- `data.ddl-not-idempotent`: repro-script: apply the migration twice on an empty local database; the second run errors Fix direction: IF NOT EXISTS guards; DO blocks for constraints and enum types.
- `data.destructive-db-command`: static-proof: the command is in a script or config Fix direction: use the project's named migration scripts against the local test database only.
- `data.person-table-no-erasure`: failing-test: seed a user in every person table, run erasure, query by id/email: rows remain
- `data.save-without-provenance`: failing-test: save with provenance=agent_fetched is accepted
- `data.lookup-by-name`: failing-test: foreign-owner resource with the same name is accepted
- `data.acl-overwrite`: failing-test: merge a private fact into a public entity; an outsider can read it
- `data.no-inverse`: failing-test: unmerge(merge(G)) != G on a small graph
- `data.edit-skips-review`: failing-test: share or publish, edit the content to include a line the review blocks, read it as an audience member; the line is visible Fix direction: route every edit of shared content through the same review, or end the share on edit until it is reviewed again.

## Verification steps

Run in this order after the change; each line is a pass criterion.

1. `data.v.migrations` immutability diff (only A), stamp uniqueness after rebase, lint on new files _(test; scan.mjs --domain data-privacy, squawk / atlas lint)_
2. `data.v.replay` replay all migrations on an empty local test database and run the schema drift diff (--exit-code) _(test; migrate deploy + migrate diff)_
3. `data.v.erasure` schema-to-erasure-registry conformance test, then the erasure round-trip test (second user's rows survive) _(test; test runner)_
4. `data.v.authz-matrix` authorization matrix (actors x resources x actions) and property-based isolation test _(test; fast-check / Hypothesis)_
5. `data.v.provenance` provenance sink tests + injection canary not found in the store _(test; test runner)_
6. `data.v.merge-props` merge/unmerge round-trip property and the no-widening invariant over random command sequences _(test; fast-check commands)_

## Triggers

Loaded by `tools/unslop/classify.mjs` when the task says "migration", "migrations", "schema", "table", "column", "database", "db", "personal data", "pii", "gdpr", "lgpd", "erasure", or touches `**/migrations/**`, `**/schema/**`, `**/*.prisma`, `**/*.sql`, `**/models/**`, `**/*erasure*`, `**/*deletion*`, `**/*privacy*`.

<!-- checks:end -->

## Tools and how to read them

| tool | how to run it | what number to read | valid only when | trap |
|---|---|---|---|---|
| migration stamps and edits | the `data.migration-*` script rules on the diff and the merged tree | no edited applied migration; unique stamps | compare against the base branch | a stamp collision that only appears after the train merges |
| squawk / sql lint | `squawk` on new SQL files (`prefer-robust-stmts`) | violations = 0 | run on the migration files only | linting the generated client instead of the SQL |
| erasure coverage | list tables with a user or person column; diff against the erasure plan | every such table is in the plan | read the schema, not the docs | a new table that keeps data after account deletion |
| migrate twice | apply the migration on a scratch database twice | second run is a no-op, no error | local test database only | trying it on the shared database |

## Known traps

| symptom | measure | cause | fix |
|---|---|---|---|
| Checksum mismatch after a merge | compare the migration file to the base | an applied migration was edited | restore it; add a new migration |
| Data left after account deletion | delete a test user; count rows by user id | table missing from the erasure plan | add it in the same branch, with a test |
| Private item visible to others after a merge | merge two items with different ACLs in a test | ACL union widened access | access is the intersection or the stricter side |

## Sources

Dated sources with their verification tags are in [SOURCES.md](SOURCES.md). Claims tagged unverified there are not stated as fact here.
