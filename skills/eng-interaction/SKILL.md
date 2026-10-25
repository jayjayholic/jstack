---
name: eng-interaction
description: "Use when a change touches scrolling, overlays and modals, mobile viewport, keyboard and focus, layout shift, hydration, URL or state races, or click and tap targets. Write the state machine, test on a real phone width."
---

# Mobile, scroll, layout and interaction: think before, prove after

Interaction bugs live between states: the keyboard opens, a second modal stacks, a list grows above the reader, the server and client render differently. Name the states and transitions before code (who owns scroll, what Esc closes, what the URL holds) and verify on a phone-sized viewport with the dynamic viewport units, not on a desktop window.

## How this pack is used

- **Before** (`/preflight`): answer the questions for the task's tier (S: MUST, M: + SHOULD, L: all + a pre-mortem). An answer that needs a number gets a number or "unknown, measure first". Copy the budgets that apply into the pre-flight with how each is measured.
- **After** (`/unslop`): the static red flags run in `tools/unslop/scan.mjs`; the review agent reads the diff for the `eyes` ones. A red flag is a hypothesis until a confirm recipe produces evidence that a second agent reproduces.
- **Machine part**: `checks.json` in this folder (triggers, questions, budgets, rules, verify). Projects tune it in `.jstack/unslop.json` (rule modes, waivers, extra questions and rules).

<!-- checks:begin (generated from checks.json by tools/unslop/packs.mjs; edit checks.json, then render) -->

## Pre-flight questions

**MUST (asked at every tier)**

- `ix.q.one-scroller` Which single element scrolls in this view, and on which axis? What happens at its edge? _(answer as: text; prevents: nested-scroll)_
- `ix.q.error-paths` Pre-mortem: this flow broke in production. List the error, cancel, timeout, reload and double-submit paths and the state after each. _(answer as: table; prevents: stuck-overlay, lost-progress)_

**SHOULD (tier M and L)**

- `ix.q.ready-state` What is the view's ready state, and which transition sets the scroll position? What stops auto-follow? _(answer as: diagram; prevents: scroll-before-content)_
- `ix.q.viewport` What sizes the shell: dvh/svh or vh? What does the keyboard do (interactive-widget)? _(answer as: text; prevents: hidden-by-keyboard)_
- `ix.q.overlay-stack` Which overlays can stack here, who owns the stack, and what does Esc close first? _(answer as: list; prevents: wrong-layer)_
- `ix.q.source-of-truth` For each state item: where is its one source of truth (URL, server or local)? What happens if two requests overlap? _(answer as: table; prevents: state-race)_
- `ix.q.subscriptions` Which effects subscribe, append, poll or start timers, and what cleans each up on unmount and on a double mount? _(answer as: table; prevents: runaway-loop, leak)_

**DEEP (tier L, with the pre-mortem)**

- `ix.q.affordance` For each interactive element: its signifier (cursor, hover, focus), its target size and its placement relative to the pointer. _(answer as: table; prevents: poor-affordance)_
- `ix.q.layout-shift` Does anything appear, disappear or change size when async data arrives? Where is its space reserved? _(answer as: text; prevents: layout-shift)_
- `ix.q.hydration` What reads device or time values, and does the first client render equal the server render? _(answer as: list; prevents: hydration-mismatch)_
- `ix.q.devices` Which device and viewport matrix will prove it, and which part can only be checked on a real device? _(answer as: list; prevents: unverified-on-device)_

## Budgets

Defaults with their source. The project file `.jstack/budgets.json` wins; `null` means the project sets it the first time a task touches it (pre-flight turns that into a measure-first task).

| key | default | unit | how measured | source |
|---|---|---|---|---|
| `perf.cls` | 0.1 | score | sum of layout-shift entries without hadRecentInput during load and status changes | web.dev CLS |
| `a11y.target_px` | 24 | CSS px | DOM target-size scan; 44 for primary touch actions | WCAG 2.2 SC 2.5.8 |
| `ix.scrollers_per_view` | 1 | count | DOM audit of overflowing auto/scroll elements per view | CSS Overscroll Behavior L1 |

## Red flags

A red flag is a hypothesis. /unslop turns it into a finding only with evidence (see Confirm recipes).

| id | what it looks like | why it is slop | detector | severity |
|---|---|---|---|---|
| `ix.vh-shell` | 100vh / h-screen sizing (sits under mobile toolbars and keyboards) | vh equals the large viewport, so the bottom of the shell hides under browser toolbars and the keyboard. | static `ix.vh-shell` (regex) | medium |
| `ix.magic-z-index` | Magic z-index number (3+ digits) | z-index arms races put modals behind other layers; there is no stack owner. | static `ix.magic-z-index` (regex) | low |
| `ix.scroll-on-mount` | scrollIntoView in a mount-only effect (runs before the content is there) | It runs while the skeleton shows, so the view never lands on the latest item. | static `ix.scroll-on-mount` (regex) | medium |
| `ix.nested-scroll` | overflow:auto inside another scroll container | Three scrollbars, a list that will not scroll, jumps on status change. | review agent (eyes) | medium |
| `ix.div-onclick` | onClick on a div/span with no role, tabIndex, cursor or keyboard support | No signifier, no keyboard access, often a tiny target. | review agent (eyes) | medium |
| `ix.late-primary-action` | Primary action rendered only when data arrives ({data && <Button/>}) | The button appears late and shifts the layout. | review agent (eyes) | low |
| `ix.overlay-no-finally` | Overlay opened with no close in catch/finally | A failed call leaves an overlay over the whole UI. | review agent (eyes) | high |
| `ix.device-read-in-render` | window/localStorage/matchMedia/Date read in render | Server and client render differ: hydration errors and flicker. | review agent (eyes) | medium |
| `ix.unaborted-fetch-effect` | fetch in an effect without abort or stale guard | A slow old response overwrites the newer selection. | review agent (eyes) | medium |
| `ix.effect-append-loop` | Effect that appends to state or the DOM with no cleanup, or with the appended state in its own dependencies | Each render or remount adds another copy: elements multiply and the page slows down. | review agent (eyes) | high |
| `ix.menu-wrong-container` | Menu or popover placed with pointer coordinates against a scrolled or transformed ancestor | The menu opens far from the pointer as soon as the container scrolls or moves. | review agent (eyes) | medium |
| `ix.url-write-before-ready` | URL or route written from an effect before the data it depends on (session, permissions) has loaded | The early write is read back as a new request and the deep link bounces somewhere else. | review agent (eyes) | medium |

## Confirm recipes

- `ix.vh-shell`: render: Pixel/iPhone emulation, focus the input, assert its bottom <= visualViewport.height Fix direction: dvh/svh (h-dvh, min-h-svh) and an explicit interactive-widget choice.
- `ix.magic-z-index`: failing-test: open A then B; elementFromPoint at B's centre is B; Esc closes B only Fix direction: the top layer (<dialog>.showModal) or a token scale owned by one overlay manager.
- `ix.scroll-on-mount`: failing-test: delay the data 1.5 s; after the skeleton goes, assert distance to bottom < 2 px Fix direction: scroll on the transition to ready, re-assert while height settles, stop at the first user scroll.
- `ix.nested-scroll`: render: DOM audit counts > 1 overflowing scroller per view
- `ix.div-onclick`: render: cursor and target-size scan; axe
- `ix.late-primary-action`: measurement: CLS during load over budget
- `ix.overlay-no-finally`: failing-test: abort the call; assert no [aria-modal=true] left and the page is interactive
- `ix.device-read-in-render`: render: built app route crawl with a non-UTC timezone; console has hydration errors
- `ix.unaborted-fetch-effect`: failing-test: A delayed 1500 ms, B 100 ms; B stays shown
- `ix.effect-append-loop`: failing-test: mount, wait 2 s, remount twice; the element count stays constant
- `ix.menu-wrong-container`: render: open it at 4 pointer positions inside a scrolled container; the distance from the pointer is over 8 px Fix direction: position against the viewport or with a positioning library (virtual element at the pointer).
- `ix.url-write-before-ready`: failing-test: delay that data 1.5 s and open a deep link; the final URL equals the deep link

## Verification steps

Run in this order after the change; each line is a pass criterion.

1. `ix.v.built` run on the production build; dev-mode hydration and CLS differ _(render; build + start)_
2. `ix.v.matrix` Pixel 7, iPhone 13, iPad, desktop 1440; non-UTC timezone and a second locale; light and dark _(render; Playwright devices)_
3. `ix.v.per-route` per route: console clean, scrollers <= 1, no horizontal overflow, target-size and cursor scans, with the longest real content and with an empty state _(render; DOM audit snippets)_
4. `ix.v.per-flow` per flow: race test, error-path matrix (abort and 500), reload-resume, overlay stack (Esc order, focus return) _(test; Playwright page.route)_
5. `ix.v.cls` interaction CLS <= 0.1 _(measure; PerformanceObserver layout-shift)_
6. `ix.v.device` real-device spot check of anything the keyboard touches, or say 'not verified on device' _(render; real device)_

## Triggers

Loaded by `tools/unslop/classify.mjs` when the task says "scroll", "mobile", "phone", "keyboard", "modal", "dialog", "overlay", "menu", "dropdown", "click", "tap", "layout", or touches `**/components/**`, `**/*.css`, `**/*.scss`, `**/hooks/**`, `**/app/**/*.tsx`, `**/*.vue`, `**/*.svelte`.

<!-- checks:end -->

## Tools and how to read them

| tool | how to run it | what number to read | valid only when | trap |
|---|---|---|---|---|
| Playwright device emulation | phone profile, `hasTouch`, keyboard open via focus on an input | element boxes vs visual viewport; nothing covered | built app; real fonts | desktop window resized is not a phone |
| CLS / layout-shift entries | PerformanceObserver `layout-shift` without `hadRecentInput` | sum <= budget during load and after data arrives | same data volume as production | empty states shift nothing; real data does |
| hydration warnings | browser console during first load of the built app | zero hydration mismatch errors | production build (dev warns differently) | `suppressHydrationWarning` hides one level only |
| target-size scan | DOM scan of interactive boxes | all >= 24x24 CSS px (WCAG 2.2 2.5.8); 44 for primary touch actions | phone viewport | icon buttons with padding outside the hit box |

## Known traps

| symptom | measure | cause | fix |
|---|---|---|---|
| Bottom of the screen hidden on phones | emulate a phone with toolbars | `100vh` / `h-screen` shell | use `dvh`/`svh` units |
| Esc closes everything | open two overlays, press Esc | no stacking order for overlays | one overlay stack; Esc closes only the top |
| Scroll jumps while reading | append items above the viewport in a test | scroll forced on mount or on every update | scroll only on the user's own new item; scroll anchoring |

## Sources

Dated sources with their verification tags are in [SOURCES.md](SOURCES.md). Claims tagged unverified there are not stated as fact here.
