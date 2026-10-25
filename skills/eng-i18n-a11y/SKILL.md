---
name: eng-i18n-a11y
description: "Use when a change touches user-visible text, locale or language choice, dates and time zones, error messages, catalogs, contrast or screen readers. Resolve language, zone and contrast from their source, never guess them."
---

# Accessibility, i18n, time zones and language: think before, prove after

Language, locale, time zone and contrast are inputs to the system, not guesses made inside it. Each has a source of truth (a user setting, an org default, an IANA zone, a token pair), a standard format (BCP 47, IANA tz, a WCAG ratio) and a mechanical check. Failures come from inferring them from text, audio, the server clock or the developer's own language, or from hand-merging catalogs.

## How this pack is used

- **Before** (`/preflight`): answer the questions for the task's tier (S: MUST, M: + SHOULD, L: all + a pre-mortem). An answer that needs a number gets a number or "unknown, measure first". Copy the budgets that apply into the pre-flight with how each is measured.
- **After** (`/unslop`): the static red flags run in `tools/unslop/scan.mjs`; the review agent reads the diff for the `eyes` ones. A red flag is a hypothesis until a confirm recipe produces evidence that a second agent reproduces.
- **Machine part**: `checks.json` in this folder (triggers, questions, budgets, rules, verify). Projects tune it in `.jstack/unslop.json` (rule modes, waivers, extra questions and rules).

<!-- checks:begin (generated from checks.json by tools/unslop/packs.mjs; edit checks.json, then render) -->

## Pre-flight questions

**MUST (asked at every tier)**

- `i18n.q.language-source` Which language does each input and output of this change have, and which field is its source (member setting, then org default, then Accept-Language, then product default)? _(answer as: table; prevents: guessed-language)_
- `i18n.q.both-catalogs` Does every new user-facing string have a key in every catalog? Do removed keys also have no code references? _(answer as: list; prevents: missing-keys)_

**SHOULD (tier M and L)**

- `i18n.q.detection` Does anything detect language from text or audio? If so, is that only for labelling input, never for choosing output? _(answer as: text; prevents: guessed-language)_
- `i18n.q.explicit-language` Does every speech-to-text, OCR or LLM call receive the language explicitly (language parameter, expected languages + threshold, system-prompt line)? _(answer as: list; prevents: wrong-script)_
- `i18n.q.time-zone` Is every time an instant, rendered in the member's IANA zone and computed at render or event time? Are dates without an instant stored floating? _(answer as: text; prevents: wrong-time)_
- `i18n.q.error-mapping` Which error codes can reach the UI, and does each map to a localized sentence with a next step? _(answer as: table; prevents: raw-error-codes)_

**DEEP (tier L, with the pre-mortem)**

- `i18n.q.literals` Is any locale, language name or 'respond in X' literal in code or prompts? _(answer as: list; prevents: locale-in-code)_
- `i18n.q.contrast` Which new colour pairs exist, and what are their WCAG ratios in light and dark? _(answer as: table; prevents: contrast)_
- `i18n.q.merge` Do I touch catalogs in a merge or rebase? Will I run the key-parity and merge-loss check afterwards? _(answer as: text; prevents: merge-lost-keys)_

## Budgets

Defaults with their source. The project file `.jstack/budgets.json` wins; `null` means the project sets it the first time a task touches it (pre-flight turns that into a measure-first task).

| key | default | unit | how measured | source |
|---|---|---|---|---|
| `i18n.missing_keys` | 0 | count | catalog parity script plus referenced-key extraction diff | house rule; QuickCheck-style invariant |
| `a11y.contrast_text` | 4.5 | ratio | axe color-contrast on built pages, light and dark | WCAG 2.2 SC 1.4.3 |
| `a11y.contrast_ui` | 3 | ratio | token ratio unit test for controls and focus rings | WCAG 2.2 SC 1.4.11 |

## Red flags

A red flag is a hypothesis. /unslop turns it into a finding only with evidence (see Confirm recipes).

| id | what it looks like | why it is slop | detector | severity |
|---|---|---|---|---|
| `i18n.prompt-language-literal` | Output language hardcoded in a prompt ('respond in English') | Every member gets that language whatever their setting. | static `i18n.prompt-language-literal` (regex) | medium |
| `i18n.date-no-timezone` | toLocaleString()/toLocaleDateString() with no locale or timeZone | Renders in the host's zone and locale (UTC on servers), not the member's. | static `i18n.date-no-timezone` (regex) | medium |
| `i18n.utc-today` | 'Today' computed from toISOString() (UTC date) | Near midnight the UTC date is the member's yesterday or tomorrow. | static `i18n.utc-today` (regex) | medium |
| `i18n.catalog-parity` | Locale catalog missing keys its sibling locales have | Members see raw keys or another language; merges that took one side whole cause exactly this. | static `i18n.catalog-parity` (script catalog-parity) | high |
| `i18n.detect-language-for-output` | Language detected from text and used to choose output | Language ID is unreliable on short strings (card titles, folder names). | review agent (eyes) | medium |
| `i18n.raw-error-to-ui` | Error code or message string shown to members (toast(error.message)) | Members read SOME_CODE or a stack trace instead of a sentence and a next step. | review agent (eyes) | medium |
| `i18n.stt-no-language` | Speech-to-text call with no language or with 'auto' and no threshold | Detection picks the wrong language and fluent text in a foreign script gets stored. | review agent (eyes) | high |

## Confirm recipes

- `i18n.prompt-language-literal`: failing-test: golden run in an org whose locale differs; output language is wrong Fix direction: interpolate the resolved locale's name into the system prompt.
- `i18n.date-no-timezone`: failing-test: run under TZ=Pacific/Kiritimati and TZ=America/Sao_Paulo; outputs differ Fix direction: Intl.DateTimeFormat(locale, { timeZone: member.timeZone }).
- `i18n.utc-today`: failing-test: freeze the clock at 23:30 in America/Sao_Paulo; assert the local date Fix direction: format the instant in the member's IANA zone.
- `i18n.catalog-parity`: static-proof: the flattened key sets differ Fix direction: add the key to every locale in the same branch.
- `i18n.detect-language-for-output`: failing-test: English source content in a pt-BR org yields pt-BR output
- `i18n.raw-error-to-ui`: failing-test: force each error path; the DOM contains none of the enum's literal codes
- `i18n.stt-no-language`: failing-test: short noisy clip in the org's language; output script matches

## Verification steps

Run in this order after the change; each line is a pass criterion.

1. `i18n.v.scans` scan locale literals, prompt language literals, detection calls, date formatting without zone, colour literals _(test; scan.mjs --domain i18n-a11y)_
2. `i18n.v.parity` catalog parity + referenced-key extraction diff = 0 _(test; catalog-parity script, formatjs extract / i18next-parser)_
3. `i18n.v.errors` error-code exhaustiveness test + e2e DOM scan for raw codes _(test; unit test + Playwright)_
4. `i18n.v.tz-matrix` TZ matrix run (Kiritimati, Pago_Pago, Sao_Paulo) gives identical results; DST property tests _(test; TZ= env + fast-check)_
5. `i18n.v.pseudo` pseudo-locale run (en-XA) of key screens: no unaccented text _(render; Playwright + pseudo-locale)_
6. `i18n.v.contrast` axe color-contrast light and dark + token ratio unit test _(render; @axe-core/playwright)_

## Triggers

Loaded by `tools/unslop/classify.mjs` when the task says "translate", "translation", "i18n", "locale", "language", "portuguese", "english", "spanish", "timezone", "time zone", "date", "dates", or touches `**/messages/**`, `**/locales/**`, `**/i18n/**`, `**/lang/**`, `**/*prompt*`, `**/*.po`.

<!-- checks:end -->

## Tools and how to read them

| tool | how to run it | what number to read | valid only when | trap |
|---|---|---|---|---|
| catalog parity | the `i18n.catalog-parity` script rule (or the project's own) across every locale | missing keys = 0 in every locale | run on the merged tree, not only the branch | a merge that took one side's JSON whole |
| time zone matrix test | run date tests with `TZ` set to a negative, zero and positive offset | same local day and time in each | the test sets the zone; the machine zone never leaks in | tests that pass only in the author's zone |
| axe-core | `color-contrast` per color scheme, `label`, `button-name` | violations = 0 | built app, both themes | contrast checked on a mock, not the render |
| pseudo-locale | a locale with long, accented strings | no clipped or overflowing text | every screen the change touches | English-only screenshots |

## Known traps

| symptom | measure | cause | fix |
|---|---|---|---|
| Reply or card in the wrong language | grep prompts for language literals | language hardcoded or guessed from text | pass the resolved locale; never infer from content |
| Wrong day shown near midnight | run with TZ at UTC-3 and UTC+9 | `toISOString().slice(0, 10)` as today | format in the user zone |
| Raw error code shown to the user | trigger the error in the UI | no error-code to message mapping | map codes to catalog keys; log the code |

## Sources

Dated sources with their verification tags are in [SOURCES.md](SOURCES.md). Claims tagged unverified there are not stated as fact here.
