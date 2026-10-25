---
name: eng-deploy-config
description: "Use when a change touches environment variables, feature flags, config files, deploy order, staging or production settings, cron schedules, domains and redirects, or removes a feature. Defaults on, env validated at start, deploy order written."
---

# Deploy, env and feature flags: think before, prove after

Config fails open and silently: a missing variable becomes an empty string, a loader that finds no file exits 0, a finished feature stays off because nobody set its flag, and a deploy goes out before the setting it needs. Validate env against a schema at startup, ship finished features on with the variable as a kill switch, keep environments in parity, and write the deploy order (settings, migrations, code) in the pre-flight.

## How this pack is used

- **Before** (`/preflight`): answer the questions for the task's tier (S: MUST, M: + SHOULD, L: all + a pre-mortem). An answer that needs a number gets a number or "unknown, measure first". Copy the budgets that apply into the pre-flight with how each is measured.
- **After** (`/unslop`): the static red flags run in `tools/unslop/scan.mjs`; the review agent reads the diff for the `eyes` ones. A red flag is a hypothesis until a confirm recipe produces evidence that a second agent reproduces.
- **Machine part**: `checks.json` in this folder (triggers, questions, budgets, rules, verify). Projects tune it in `.jstack/unslop.json` (rule modes, waivers, extra questions and rules).

<!-- checks:begin (generated from checks.json by tools/unslop/packs.mjs; edit checks.json, then render) -->

## Pre-flight questions

**MUST (asked at every tier)**

- `deploy.q.flags` Which flags does this add, what type is each (release, ops, experiment, permission), what is its default, and when is it removed? Without anyone setting a variable, what does a user see after the merge? _(answer as: table; prevents: shipped-off)_
- `deploy.q.env-keys` Which env keys are new or changed, and are they declared in the schema and present (by name) in every target environment? _(answer as: table; prevents: missing-env)_

**SHOULD (tier M and L)**

- `deploy.q.order` In what order must secrets, migrations, schedules and code land, and does each step survive if the next one fails? _(answer as: list; prevents: crashloop-order)_
- `deploy.q.clients` Which external clients or protocols consume this, and how is each one tested? _(answer as: table; prevents: untested-clients)_
- `deploy.q.routes` Which host, route or redirect config does this touch, and what is the URL table to probe after the deploy? _(answer as: table; prevents: config-unverified)_
- `deploy.q.removal` What does this retire, and where is the removal manifest (routes, components, keys, env vars, cron entries, permission keys)? _(answer as: list; prevents: incomplete-removal)_

**DEEP (tier L, with the pre-mortem)**

- `deploy.q.shared-infra` Does any credential, token, schedule or destination get shared between stage and production? _(answer as: text; prevents: shared-infra)_
- `deploy.q.fail-open` Does any step read a shared mutable directory or a fail-open loader? _(answer as: text; prevents: fail-open-loader)_
- `deploy.q.premortem` Pre-mortem: it is a week later and this release failed. What is the most likely reason? _(answer as: text; prevents: release-failure)_

## Budgets

Defaults with their source. The project file `.jstack/budgets.json` wins; `null` means the project sets it the first time a task touches it (pre-flight turns that into a measure-first task).

| key | default | unit | how measured | source |
|---|---|---|---|---|
| `deploy.required_keys_missing` | 0 | count | env names per target vs the schema's required keys (names only) | Twelve-Factor III/X; PCheck OSDI 2016 |
| `deploy.flags_past_removal_date` | 0 | count | flag inventory with removal dates | Hodgson, Feature Toggles (2017); Piranha ICSE-SEIP 2020 |
| `deploy.retired_urls_serving_200` | 0 | count | curl table over retired URLs | Parallel Change (Sato 2014) |

## Red flags

A red flag is a hypothesis. /unslop turns it into a finding only with evidence (see Confirm recipes).

| id | what it looks like | why it is slop | detector | severity |
|---|---|---|---|---|
| `deploy.flag-default-off` | Feature gated by process.env.X === 'true' (off when the variable is absent) | A finished feature ships invisible until someone sets a variable in every environment. | static `deploy.flag-default-off` (regex) | medium |
| `deploy.env-silent-empty` | process.env.X \|\| '' / ?? '' / non-null assertion (silent empty config) | A missing key becomes an empty string that fails later, far from the cause. | static `deploy.env-silent-empty` (regex) | medium |
| `deploy.dotenvx-not-strict` | dotenvx run without --strict (fails open: missing file injects nothing) | A typo in the env path runs the command with zero variables and exit 0. | static `deploy.dotenvx-not-strict` (regex) | medium |
| `deploy.tunnel-host` | Tunnel host committed (ngrok, trycloudflare, loca.lt) | A dead or someone else's tunnel becomes a production callback URL. | static `deploy.tunnel-host` (regex) | medium |
| `deploy.missing-runbook-order` | New required key or migration with no 'how to deploy' order in the PR | Code lands before its key and crash-loops. | review agent (eyes) | high |
| `deploy.manual-schedule` | Schedule, cron or webhook created by hand, not declared in the repo | Undeclared infrastructure drifts and points at the wrong host. | review agent (eyes) | medium |
| `deploy.reused-flag` | Retired flag name reused for a new meaning, or a deleted page whose route/keys/cron remain | Old code wakes up (Knight Capital, 2012). | review agent (eyes) | high |
| `deploy.one-client-tested` | 'Tested in client A' generalized to every client | Each client discovers and authenticates differently. | review agent (eyes) | medium |
| `deploy.shared-generated-dir` | Generated code or build cache shared with other checkouts or sessions (a link or an absolute path outside the worktree) | Another session's regenerate empties it and this checkout's running server starts failing. | review agent (eyes) | medium |

## Confirm recipes

- `deploy.flag-default-off`: failing-test: boot with no flag variables; the feature's smoke test fails Fix direction: release and ops toggles default ON with OFF as the lever, read through the config schema.
- `deploy.env-silent-empty`: failing-test: boot with an empty env; the process starts instead of exiting with the key's name Fix direction: one schema reads process.env and fails fast at startup.
- `deploy.dotenvx-not-strict`: repro-script: point -f at a missing file; the command still runs Fix direction: add --strict, then probe the loaded key names.
- `deploy.tunnel-host`: static-proof: the host is in a committed value Fix direction: per-environment host from config, validated against an allowlist.
- `deploy.missing-runbook-order`: failing-test: boot the new build with the old env; it crashes instead of degrading
- `deploy.manual-schedule`: measurement: live schedule list vs the declared list differs
- `deploy.reused-flag`: repro-script: git log -S<flag> shows the old meaning; retired URL returns 200
- `deploy.one-client-tested`: measurement: client matrix run records a failure
- `deploy.shared-generated-dir`: repro-script: regenerate in a second checkout; the first checkout's running server starts failing

## Verification steps

Run in this order after the change; each line is a pass criterion.

1. `deploy.v.static` schema-only env access, flag inventory with defaults, --strict on loaders, tunnel-host scan, removal-manifest grep = 0 _(test; scan.mjs --domain deploy-config + git grep)_
2. `deploy.v.negative-boot` boot with an empty env -> clear exit or degraded mode; flag absent -> intended default _(test; unit test)_
3. `deploy.v.parity` env names per target vs the schema; schedules vs the declaration; credential hashes differ per environment _(measure; platform CLI (names only) + sha256)_
4. `deploy.v.ordered` follow the written runbook (READ-DO); canary where available _(test; runbook)_
5. `deploy.v.probes` post-deploy probes on stage: health and key presence, host/route table, retired URLs, protocol discovery, smoke test with no flags set, client matrix _(measure; curl table)_

## Triggers

Loaded by `tools/unslop/classify.mjs` when the task says "deploy", "release", "env", "environment", "variable", "variables", "flag", "flags", "feature flag", "toggle", "config", "staging", or touches `**/.env*`, `**/env.*`, `**/*config*`, `**/vercel.json`, `**/next.config.*`, `**/*flag*`, `**/*toggle*`, `**/Dockerfile*`.

<!-- checks:end -->

## Tools and how to read them

| tool | how to run it | what number to read | valid only when | trap |
|---|---|---|---|---|
| env schema | a schema (zod or similar) parsed at startup | missing or malformed variables fail the boot with their names | every environment | defaults that hide a missing secret |
| env parity | diff the variable names across environments | every name present where the code reads it | names only, never values | a variable set locally and missing on stage |
| probe after load | print which variables were loaded (names) after the loader runs | expected count > 0 | loader in strict mode | a loader that exits 0 with nothing loaded |
| deploy order check | the pre-flight lists settings -> migrations -> code -> flags | each step verified before the next | stage first | code that needs a setting deployed first |

## Known traps

| symptom | measure | cause | fix |
|---|---|---|---|
| Works locally, broken on stage | env parity diff | variable missing on stage | schema at boot; parity check |
| Feature shipped but invisible | grep `=== 'true'` flags | default off | default on; env var only to turn it off |
| Callbacks point at a dead host | grep committed hosts | personal tunnel URL committed | host from config |

## Sources

Dated sources with their verification tags are in [SOURCES.md](SOURCES.md). Claims tagged unverified there are not stated as fact here.
