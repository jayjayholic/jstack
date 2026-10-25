---
name: eng-copy
description: "Use when writing or changing user-facing text: labels, headings, empty states, notifications, emails, onboarding, consent and terms, names of features. Fewer words, the user's words, standard patterns."
---

# Product copy, text density, naming and consent: think before, prove after

Copy slop is explanation instead of design: walls of text, filler headings, internal vocabulary, invented framing and rules that lived only in someone's memory. Write for scanning (people read in an F pattern and skip filler), use the words the user uses, follow established patterns for consent, and turn every house rule into a linter rule so it cannot be forgotten.

## How this pack is used

- **Before** (`/preflight`): answer the questions for the task's tier (S: MUST, M: + SHOULD, L: all + a pre-mortem). An answer that needs a number gets a number or "unknown, measure first". Copy the budgets that apply into the pre-flight with how each is measured.
- **After** (`/unslop`): the static red flags run in `tools/unslop/scan.mjs`; the review agent reads the diff for the `eyes` ones. A red flag is a hypothesis until a confirm recipe produces evidence that a second agent reproduces.
- **Machine part**: `checks.json` in this folder (triggers, questions, budgets, rules, verify). Projects tune it in `.jstack/unslop.json` (rule modes, waivers, extra questions and rules).

<!-- checks:begin (generated from checks.json by tools/unslop/packs.mjs; edit checks.json, then render) -->

## Pre-flight questions

**MUST (asked at every tier)**

- `copy.q.show-not-say` What can the UI show instead of saying it (state, preview, default, example, disabled reason)? What is the word budget, and which one sentence must survive? _(answer as: number; prevents: text-walls)_
- `copy.q.claim-sources` For every claim about product behaviour in this copy: what is its source (code path, spec line, owner quote)? No source, no claim. _(answer as: table; prevents: invented-framing)_

**SHOULD (tier M and L)**

- `copy.q.real-data` Have I rendered this with >= 5 real records and the extreme values (longest, shortest, empty)? _(answer as: file; prevents: filler-templates)_
- `copy.q.headings` Does every heading carry instance-specific information? Does every proactive item have one specific fact and one one-tap action? _(answer as: text; prevents: filler-headings, no-cta)_
- `copy.q.member-words` Is every term the member's word? Is any internal or ops term left? _(answer as: list; prevents: jargon)_
- `copy.q.pattern` Which established pattern governs this surface (consent, form, error, empty state), and does the copy follow it? _(answer as: text; prevents: reinvented-consent)_

**DEEP (tier L, with the pre-mortem)**

- `copy.q.names` Is every new name in the glossary, and unique to one concept? _(answer as: list; prevents: name-collision)_
- `copy.q.house-lint` Which house rules apply here, and does each one have a lint (houseRules in .jstack/unslop.json) that will catch me? _(answer as: list; prevents: rule-in-memory-only)_

## Budgets

Defaults with their source. The project file `.jstack/budgets.json` wins; `null` means the project sets it the first time a task touches it (pre-flight turns that into a measure-first task).

| key | default | unit | how measured | source |
|---|---|---|---|---|
| `copy.card_body_words` | 25 | words | word count of rendered card text | example budget; Nielsen 1997 (79% scan) |
| `copy.modal_words` | 60 | words | word count of rendered modal text | example budget |
| `copy.sentence_words_max` | 20 | words | longest sentence per new string | plain-language practice, ISO 24495-1:2023 |

## Red flags

A red flag is a hypothesis. /unslop turns it into a finding only with evidence (see Confirm recipes).

| id | what it looks like | why it is slop | detector | severity |
|---|---|---|---|---|
| `copy.filler-words` | Hedge or filler word in user-facing text (simply, seamlessly, easily...) | Filler costs reading time and promises ease the UI has to deliver anyway. | static `copy.filler-words` (regex) | low |
| `copy.meta-narration` | Meta-narration ('This screen lets you...', 'Below you will find...') | Explains the UI instead of making it obvious; nobody reads it. | static `copy.meta-narration` (regex) | low |
| `copy.generic-heading` | Generic heading value (Overview, Insights, Summary, Details...) | A heading that says nothing gives no information scent. | static `copy.generic-heading` (regex) | low |
| `copy.consent-no-link` | 'You agree' / terms text with no link next to it | Assent without a linked, conspicuous notice is weak (Meyer v. Uber, 2017). | review agent (eyes) | high |
| `copy.identical-cards` | Cards whose text differs only in one slot | Template text dominates the data; members stop reading. | review agent (eyes) | medium |
| `copy.invented-claim` | Copy claims product behaviour with no source | The agent filled a gap with plausible framing; it may contradict the spec. | review agent (eyes) | high |

## Confirm recipes

- `copy.filler-words`: static-proof: the word is in a user-facing string Fix direction: delete it; if the sentence collapses, the UI should show it instead.
- `copy.meta-narration`: static-proof: the phrase is in a user-facing string Fix direction: remove; use a specific heading or an example instead.
- `copy.generic-heading`: render: heading-only read-through of 5 real records shows identical headings Fix direction: name the instance: a subject, number or date.
- `copy.consent-no-link`: render: DOM test finds no a[href] to the terms in the notice
- `copy.identical-cards`: measurement: pairwise token Jaccard > 0.8 across rendered cards for different entities
- `copy.invented-claim`: repro-script: claim-to-source table with an empty source cell

## Verification steps

Run in this order after the change; each line is a pass criterion.

1. `copy.v.lint` prose lint (house banned words, jargon, hedges) over every locale file _(test; scan.mjs --domain copy / Vale)_
2. `copy.v.measure` word counts per component and readability per new string vs the budget _(measure; script over catalog keys; text-readability)_
3. `copy.v.render` render with real data at 375 px and desktop; contact sheet; axe link names and contrast _(render; Playwright + axe)_
4. `copy.v.sameness` pairwise similarity across rendered cards; heading-only read-through _(measure; token Jaccard script)_
5. `copy.v.claims` claim-to-source table for copy that describes behaviour _(test; manual table in the PR)_

## Triggers

Loaded by `tools/unslop/classify.mjs` when the task says "copy", "text", "wording", "label", "heading", "title", "message", "notification", "email", "onboarding", "consent", "terms", or touches `**/messages/**`, `**/locales/**`, `**/i18n/**`, `**/copy/**`, `**/*.po`, `**/emails/**`.

<!-- checks:end -->

## Tools and how to read them

| tool | how to run it | what number to read | valid only when | trap |
|---|---|---|---|---|
| house rules as config | `houseRules.bannedWords` and `jargon` in `.jstack/unslop.json` (the scanner turns them into rules) | hits = 0 in changed catalog strings | the project owns the word list | a rule that lives only in a chat |
| word budget | count words per string and per screen in the catalog diff | within the budget the pre-flight set | count the rendered screen, not the key | one long helper paragraph per screen |
| cold read | a fresh agent or person reads only the screen and says what it does and what to tap | they name the action in one try | no access to the code or the brief | the author grading their own copy |
| readability | `text-readability` / `textstat` on new strings | grade within the project's target | language-specific formulas for non-English text | English formulas applied to other languages |

## Known traps

| symptom | measure | cause | fix |
|---|---|---|---|
| Screen explains itself | grep catalogs for "this page lets you" | explaining instead of making the UI obvious | cut the sentence; make the control say it |
| Every card says the same thing | render with real data, not placeholders | template never reviewed with real data | review with real data before shipping |
| "You agree" with nothing to read | click the consent text | unlinked terms, custom pattern | link the terms; use the standard clickwrap pattern |

## Sources

Dated sources with their verification tags are in [SOURCES.md](SOURCES.md). Claims tagged unverified there are not stated as fact here.
