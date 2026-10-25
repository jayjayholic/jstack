---
name: eng-security
description: "Use when a change touches auth, sessions, permissions and roles, tenant data access, redirects, OAuth, webhooks, regex on input, logs of errors, exposed ports, or secrets. Ownership checked on every object, deny by default, nothing secret leaves."
---

# Security and secrets: think before, prove after

Every object read or written proves the caller owns it (tenant and owner in the query, not only the id), every route and tool is gated by a declared permission and denies by default, protocols follow their best-current-practice documents with negative tests, and nothing secret leaves the machine: not in logs, error dumps, screenshots, PR text or committed commands.

## How this pack is used

- **Before** (`/preflight`): answer the questions for the task's tier (S: MUST, M: + SHOULD, L: all + a pre-mortem). An answer that needs a number gets a number or "unknown, measure first". Copy the budgets that apply into the pre-flight with how each is measured.
- **After** (`/unslop`): the static red flags run in `tools/unslop/scan.mjs`; the review agent reads the diff for the `eyes` ones. A red flag is a hypothesis until a confirm recipe produces evidence that a second agent reproduces.
- **Machine part**: `checks.json` in this folder (triggers, questions, budgets, rules, verify). Projects tune it in `.jstack/unslop.json` (rule modes, waivers, extra questions and rules).

<!-- checks:begin (generated from checks.json by tools/unslop/packs.mjs; edit checks.json, then render) -->

## Pre-flight questions

**MUST (asked at every tier)**

- `sec.q.ownership` Which objects does this change read or write, and which line proves the caller's tenant/owner matches? _(answer as: table; prevents: bola)_
- `sec.q.gate` Which permission key and scope gate each new route or tool, and is it declared as data in the registry? Is the public allowlist delta empty? _(answer as: table; prevents: missing-authz)_

**SHOULD (tier M and L)**

- `sec.q.revocation` For every credential or copied ACL: how is it revoked, and what is the max staleness? _(answer as: table; prevents: stale-authz)_
- `sec.q.input-sinks` Does any input flow into a redirect, regex, shell, SQL or HTML? What bound or allowlist applies? _(answer as: list; prevents: open-redirect, redos, injection)_
- `sec.q.protocol` Am I implementing a protocol (OAuth/OIDC, webhook signature)? Which BCP section am I following, and which negative tests prove it? _(answer as: text; prevents: incomplete-protocol)_
- `sec.q.error-logs` What does an error from this path log? Could it include headers, URLs, configs or tokens? _(answer as: text; prevents: secrets-in-logs)_

**DEEP (tier L, with the pre-mortem)**

- `sec.q.exposure` What new listener, port, endpoint or container appears, and what is its default exposure? _(answer as: list; prevents: unsafe-defaults)_
- `sec.q.artifacts` Which artifacts leave the machine (PR text, screenshots, docs, transcripts), and were they scanned? _(answer as: list; prevents: secret-leak)_
- `sec.q.stride` STRIDE, one line per changed data flow: who could spoof, tamper, read, deny or escalate here? _(answer as: table; prevents: unreviewed-change)_

## Budgets

Defaults with their source. The project file `.jstack/budgets.json` wins; `null` means the project sets it the first time a task touches it (pre-flight turns that into a measure-first task).

| key | default | unit | how measured | source |
|---|---|---|---|---|
| `sec.ungated_routes` | 0 | count | route/tool inventory: entries neither gated nor in the public allowlist | OWASP API5:2023; architecture fitness functions |
| `sec.canary_leaks` | 0 | count | sentinel secrets found in logs, artifacts and outputs after a test run | OWASP Logging Cheat Sheet; CWE-532 |
| `sec.redos_ms_at_max_input` | 50 | ms | regex timing at the max accepted input length with a pumped attack string | CWE-1333; Davis et al. FSE 2018 |

## Red flags

A red flag is a hypothesis. /unslop turns it into a finding only with evidence (see Confirm recipes).

| id | what it looks like | why it is slop | detector | severity |
|---|---|---|---|---|
| `sec.regexp-from-input` | RegExp built from request or user input | Regex injection and catastrophic backtracking on attacker-chosen patterns. | static `sec.regexp-from-input` (regex) | high |
| `sec.password-in-command` | Password on a command line or inside a connection string | Visible to every local user in the process list and kept in shell history and transcripts (CWE-214). | static `sec.password-in-command` (regex) | high |
| `sec.raw-error-log` | Raw error/response/config object logged | HTTP and DB client errors carry headers, URLs with keys and configs (CWE-532). | static `sec.raw-error-log` (regex) | low |
| `sec.public-port-bind` | Compose service port published on all interfaces | A dev database or metrics port reachable from the network, often with default credentials. | static `sec.public-port-bind` (regex) | medium |
| `sec.missing-ownership` | Lookup by client-supplied id with no tenant/owner condition | Another tenant's object is one id away (OWASP API1:2023). | review agent (eyes) | high |
| `sec.route-without-gate` | New route/procedure/tool with no permission call and not in the public allowlist | Anyone signed in (or anyone) can call it. | review agent (eyes) | high |
| `sec.role-name-check` | Authorization by role name (role === 'ADMIN', isAdmin) instead of the permission resolver | Custom roles and scopes are bypassed or over-granted. | review agent (eyes) | medium |
| `sec.open-redirect` | Redirect target from request input without an origin compare | Phishing via a trusted domain (CWE-601). | review agent (eyes) | high |
| `sec.no-revocation-path` | Token without expiry, or an ACL copied to another store with no update path | Removed users keep access. | review agent (eyes) | high |

## Confirm recipes

- `sec.regexp-from-input`: measurement: pumped attack string at 1e3/1e4/1e5 grows super-linearly or breaks the budget Fix direction: escape the input, bound its length, or use a linear engine.
- `sec.password-in-command`: static-proof: the credential is in the command or file Fix direction: read credentials from env or a password file.
- `sec.raw-error-log`: failing-test: canary secret in env, force a provider error, grep outputs for the canary Fix direction: log message, code and status only.
- `sec.public-port-bind`: measurement: ss -ltn / netstat shows 0.0.0.0:<port> Fix direction: bind to 127.0.0.1:<host>:<container>.
- `sec.missing-ownership`: failing-test: two tenants; B's member requests A's id and gets 200
- `sec.route-without-gate`: failing-test: call it with a token lacking the permission; expect 403
- `sec.role-name-check`: failing-test: permission matrix property test finds an over- or under-grant
- `sec.open-redirect`: failing-test: next=https://evil.example and //evil.example resolve off-origin
- `sec.no-revocation-path`: failing-test: grant, use, revoke, reuse the same token -> still works

## Verification steps

Run in this order after the change; each line is a pass criterion.

1. `sec.v.inventory` route/tool inventory diff: every entry gated or allowlisted _(test; fitness test over the router registry)_
2. `sec.v.bola` two-tenant tests for each changed endpoint (1 positive, 2 negative) _(test; test runner)_
3. `sec.v.matrix` permission/scope matrix property test _(test; fast-check)_
4. `sec.v.revocation` revocation test per credential type and derived ACL _(test; test runner)_
5. `sec.v.protocol` protocol negative tests (state, PKCE, redirect allowlist, webhook signature) _(test; test runner)_
6. `sec.v.canary` canary-secret run: sentinel secrets, run suite, grep all outputs = 0 _(test; tools/memory/secrets.mjs + grep)_
7. `sec.v.secret-scan` secret scan of the diff and every outbound artifact _(test; gitleaks / trufflehog)_

## Triggers

Loaded by `tools/unslop/classify.mjs` when the task says "auth", "login", "oauth", "token", "session", "permission", "permissions", "role", "roles", "admin", "secret", "secrets", or touches `**/auth/**`, `**/*auth*`, `**/*session*`, `**/*permission*`, `**/*role*`, `**/middleware*`, `**/routers/**`, `**/api/**`.

<!-- checks:end -->

## Tools and how to read them

| tool | how to run it | what number to read | valid only when | trap |
|---|---|---|---|---|
| ownership tests | call each new route as another tenant's user | 403/404, never data | real permission resolver | testing only the happy path |
| secret scan | `gitleaks detect` on the diff and on artifacts (PR body, screenshots text, reports) | 0 findings | scan what leaves, not only the repo | a token pasted in a PR description |
| regex safety | never compile user input; test patterns with long adversarial strings | bounded time | escape or use literal matching | nested quantifiers on unbounded input |
| exposure check | list new listeners, ports, public routes | bound to loopback or behind auth | compose and server config | `0.0.0.0` by default |

## Known traps

| symptom | measure | cause | fix |
|---|---|---|---|
| User sees another tenant's data | cross-tenant request in a test | lookup by id only | scope every query by tenant/owner |
| Secrets in logs | grep logs for header and token shapes | whole error objects logged | log code and message only |
| Open redirect | next=//evil.example | prefix or includes checks | allowlist of paths |

## Defers to

`security-review` if installed.

## Sources

Dated sources with their verification tags are in [SOURCES.md](SOURCES.md). Claims tagged unverified there are not stated as fact here.
