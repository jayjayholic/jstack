---
name: eng-ui-visual
description: "Use when building or restyling a screen, modal, card, theme, icon, logo, generated document or image. Reference first, tokens only, both themes rendered and compared before anyone is asked to look."
---

# UI and visual design (house style, tokens, themes, generated artifacts): think before, prove after

Visual slop comes from designing without a reference and checking without a render: a raw color that breaks dark mode, a component that ignores the house pattern, a generated image nobody compared. Decide the reference (an existing screen or a mock) before code, build from tokens and existing components, and prove it with screenshots of the built app in light and dark at phone and desktop width.

## How this pack is used

- **Before** (`/preflight`): answer the questions for the task's tier (S: MUST, M: + SHOULD, L: all + a pre-mortem). An answer that needs a number gets a number or "unknown, measure first". Copy the budgets that apply into the pre-flight with how each is measured.
- **After** (`/unslop`): the static red flags run in `tools/unslop/scan.mjs`; the review agent reads the diff for the `eyes` ones. A red flag is a hypothesis until a confirm recipe produces evidence that a second agent reproduces.
- **Machine part**: `checks.json` in this folder (triggers, questions, budgets, rules, verify). Projects tune it in `.jstack/unslop.json` (rule modes, waivers, extra questions and rules).

<!-- checks:begin (generated from checks.json by tools/unslop/packs.mjs; edit checks.json, then render) -->

## Pre-flight questions

**MUST (asked at every tier)**

- `ui.q.reference` Which existing screen is the visual reference, and which kit components will I reuse? If there is no agreed image of good, render 2-3 options first. _(answer as: file; prevents: off-brand, no-reference)_
- `ui.q.scope` Is this a restyle (no new elements) or a redesign (new elements)? Write the one-line scope. _(answer as: text; prevents: scope-creep)_

**SHOULD (tier M and L)**

- `ui.q.tokens` Which tokens cover every colour, radius, spacing and font I need; which are missing and go into the token file first? _(answer as: list; prevents: hardcoded-values)_
- `ui.q.states-themes` Which states and themes exist: default, empty, loading, error, 404, permission-denied x light/dark x desktop/mobile? _(answer as: table; prevents: one-theme-only)_
- `ui.q.brand-surfaces` Which brand surfaces could this touch (logo, mascot, sign-in), and are they under screenshot baselines? _(answer as: list; prevents: brand-regression)_
- `ui.q.artifact-template` For generated artifacts (documents, images, chat answers): what is the template, and what do the first line and first page look like? _(answer as: file; prevents: ugly-artifact)_
- `ui.q.gallery` Is every new component or screen registered where the project keeps its component gallery or catalogue, so the next restyle reaches it? _(answer as: list; prevents: orphan-ui)_

**DEEP (tier L, with the pre-mortem)**

- `ui.q.invented-rules` Which prompt or design restrictions come from the owner's words, and which did I invent? _(answer as: list; prevents: invented-constraints)_
- `ui.q.density` What density applies (compact for data tables; width follows content)? _(answer as: text; prevents: poor-density)_
- `ui.q.premortem` Pre-mortem: it shipped and got reverted. What was the reason? _(answer as: text; prevents: reverted-redesign)_

## Budgets

Defaults with their source. The project file `.jstack/budgets.json` wins; `null` means the project sets it the first time a task touches it (pre-flight turns that into a measure-first task).

| key | default | unit | how measured | source |
|---|---|---|---|---|
| `a11y.contrast_text` | 4.5 | ratio | axe color-contrast in light and dark, including opened modals | WCAG 2.2 SC 1.4.3 |
| `a11y.contrast_ui` | 3 | ratio | token pair ratio for borders, icons, focus rings | WCAG 2.2 SC 1.4.11 |
| `ui.new_color_literals` | 0 | count | ui.hardcoded-color hits on added lines | DTCG Design Tokens Format 2025.10 |

## Red flags

A red flag is a hypothesis. /unslop turns it into a finding only with evidence (see Confirm recipes).

| id | what it looks like | why it is slop | detector | severity |
|---|---|---|---|---|
| `ui.hardcoded-color` | Colour literal outside the token files | Bypasses the tokens, so it breaks in the other theme and drifts from the brand. | static `ui.hardcoded-color` (regex) | medium |
| `ui.raw-primitive` | Raw <button>/<input>/<dialog> or third-party primitive in a feature file when the kit has one | Screens built from raw primitives look and behave unlike the rest of the app. | review agent (eyes) | medium |
| `ui.restyle-adds-elements` | New sections, heroes, decorative cards or filler text in a restyle | Nobody asked for them; the owner reverts them. | review agent (eyes) | medium |
| `ui.one-theme-only` | Surface checked in one theme only; portal rendered outside the theme root | Invisible buttons and wrong-theme modals in the other theme. | review agent (eyes) | high |
| `ui.artifact-chat-preface` | Generated document opens with a chat preface or carries Markdown residue | The document reads like a chat reply, not a document. | review agent (eyes) | medium |
| `ui.stale-screenshot` | Screenshot older than the last source change or without a commit stamp | The image shows code that is no longer there. | review agent (eyes) | medium |
| `ui.raw-palette-class` | Raw utility palette class (bg-black/55, text-green-500) instead of a token class | A palette colour is a literal with another name: it ignores the theme and drifts from the tokens. | static `ui.raw-palette-class` (regex) | medium |
| `ui.component-not-in-gallery` | New shared component with no entry in the component gallery or stories | A component nobody can see in the gallery is missed by the next restyle and audit. | review agent (eyes) | low |
| `ui.invented-restriction` | New 'never / only / always' constraint in a generation prompt or design spec with no source in the request | Self-invented limits narrow every output (one colour, one body type, refused styles) and nobody asked for them. | review agent (eyes) | medium |

## Confirm recipes

- `ui.hardcoded-color`: static-proof plus render: the element in dark mode fails contrast or differs from the token value Fix direction: use or add a token; never a literal in a feature file.
- `ui.raw-primitive`: render: side-by-side screenshot with the reference screen
- `ui.restyle-adds-elements`: render: aria/heading outline diff vs base shows new landmarks
- `ui.one-theme-only`: render: axe color-contrast per emulated colorScheme with each modal open
- `ui.artifact-chat-preface`: static-proof on extracted text: first paragraph matches a preface pattern
- `ui.stale-screenshot`: static-proof: screenshot mtime < newest changed source file
- `ui.raw-palette-class`: static-proof plus render: the class is on an added line; in the other theme the element fails contrast or differs from the token value Fix direction: map it to a semantic token class (bg-surface, text-danger). Known false positives: projects whose tokens are the raw palette by design (turn the rule off in .jstack/unslop.json).
- `ui.component-not-in-gallery`: static-proof: the component name has no reference under the gallery or stories folder at HEAD
- `ui.invented-restriction`: repro-script: quote the request next to each new constraint (empty source cell), then generate 10 samples with and without it and show the narrowed spread

## Verification steps

Run in this order after the change; each line is a pass criterion.

1. `ui.v.token-lint` token lint over every styling surface: no new colour literals on added lines _(test; scan.mjs ui.hardcoded-color / stylelint declaration-strict-value)_
2. `ui.v.matrix` built app: screen inventory x {light, dark} x {desktop, 390 px mobile} _(render; Playwright projects)_
3. `ui.v.contrast` axe color-contrast per theme with modals and menus open: 0 violations _(render; @axe-core/playwright)_
4. `ui.v.structure` restyle: aria/heading outline unchanged vs base _(render; toMatchAriaSnapshot)_
5. `ui.v.brand` toHaveScreenshot on brand surfaces in both themes; brand asset hashes match the manifest; img naturalWidth > 0 _(render; Playwright)_
6. `ui.v.sheet` before/after contact sheet stamped with HEAD, opened for the reviewer _(render; Playwright + sheet script)_

## Triggers

Loaded by `tools/unslop/classify.mjs` when the task says "ui", "design", "redesign", "restyle", "screen", "page", "modal", "card", "theme", "dark", "light", "color", or touches `**/*.css`, `**/*.scss`, `**/components/**`, `**/app/**/*.tsx`, `**/pages/**/*.tsx`, `**/*.vue`, `**/*.svelte`, `**/theme*/**`.

<!-- checks:end -->

## Tools and how to read them

| tool | how to run it | what number to read | valid only when | trap |
|---|---|---|---|---|
| Playwright screenshots | `toHaveScreenshot` (baselines committed) with `colorScheme` light and dark, phone and desktop viewports | pixel diff vs baseline; side-by-side with the reference | built app, fonts loaded, animations off | a screenshot of a stubbed or stale page |
| axe-core | `@axe-core/playwright` once per color scheme | `color-contrast` violations = 0 | run after the theme is applied | one scheme checked, the other broken |
| stylelint strict values | `scale-unlimited/declaration-strict-value` on color properties | raw colors outside the token files | token files excluded on purpose | tokens defined inline in components |
| contact sheet | one image with before/after of every changed screen for the human | the human approves the look, not the code | same data and viewport in both | asking for approval with only a description |

## Known traps

| symptom | measure | cause | fix |
|---|---|---|---|
| Looks right in light, broken in dark | screenshot both schemes | raw color or missing token pair | token pair per role; contrast check per scheme |
| New component looks foreign | compare with the nearest existing screen | built from scratch instead of the house pattern | reuse the existing component; extend the token set |
| Generated document or image off-brand | render it and view it at real size | template never rendered with real data | render with real data before shipping |

## Defers to

the project's house-style skill when it has one.

## Sources

Dated sources with their verification tags are in [SOURCES.md](SOURCES.md). Claims tagged unverified there are not stated as fact here.
