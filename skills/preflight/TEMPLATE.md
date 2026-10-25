# Pre-flight: <one-line task>   tier: S|M|L (<one reason>)   base: <sha>   date: <iso date>

## Ask (verbatim)

> <the request, copied exactly>

| # | item | kind (DIRECTIVE / QUESTION / INFO) | acceptance check |
|---|---|---|---|
| 1 | | | |

## Not requested

- <what the ask does not cover, so nobody builds it>

## Domains

| domain | why (classify reason or yours) | questions answered |
|---|---|---|
| | | |

## Memory read

| entry | kind | anchor status | how it applies |
|---|---|---|---|
| | | FRESH / DRIFTED / MOVED / STALE | |

(or: "no project memory")

## Answers

### <domain>

- `<question id>`: <answer>   (artifact: <number / diagram path / file / "unknown, measure first">)

## Budgets

| key | value | unit | how measured | where (env) |
|---|---|---|---|---|
| | | | | |

## Acceptance checks (runnable, written before code)

- [ ] <check>: `<command>` on <environment>, pass when <threshold>

## Verification plan

1. <step> with <tool>; pass when <criterion>
2. A/B decision rule (if any): <metric>, n per arm, interval, what counts as a win, written before the runs

## Scope fence

- OWNED: <paths>
- FORBIDDEN: <paths, with the reason or memory entry>
- OUTWARD / IRREVERSIBLE (approval needed): <action -> who approves>
- ROLLBACK: <how to undo>

## Pre-mortem (tier L)

It shipped and was reverted a week later. Why?

1.
2.
3.

| failure mode | effect | how we detect it | severity |
|---|---|---|---|

## Open unknowns, measured first

- <unknown> -> <how it gets measured, before any code>
