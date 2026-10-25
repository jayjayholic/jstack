# Sources: Mobile, scroll, layout and interaction

Carried over from the research pass of 2026-10-25 (`02-research-interaction-layout.md`), product-specific lines removed. Each line keeps the tag it had there: **[V]** checked against the primary page in that pass; **[K]**, **[B]**, **[C]** or **[M]** a known citation (author, year, venue) not re-opened; **[U]** unverified, treat as a hypothesis. Lines without a tag were cited with their venue and date only.

- S1 - W3C, *CSS Scroll Anchoring Module Level 1* (`overflow-anchor`); MDN "Guide to scroll anchoring" - WD / living - [V]
- S2 - W3C, *CSS Overscroll Behavior Module Level 1* (`overscroll-behavior`, scroll chaining); MDN - WD / living - [V]
- S3 - W3C, *CSS Values and Units Module Level 4*: small/large/dynamic viewport units (`svh`/`lvh`/`dvh`). MDN notes that `vh` equals `lvh`, so a box sized with it "can be covered when [toolbars] expand" - WD / living - [V]
- S4 - Chrome for Developers, "Prepare for viewport resize behavior changes coming to Chrome on Android" (`interactive-widget=resizes-visual\ - resizes-content\ - overlays-content`, Chrome 108) - last updated 2022-10-28 (no publication date shown) - [V]
- S5 - WHATWG HTML `<dialog>` / top layer; MDN `<dialog>` (Accessibility section): "If multiple modal dialogs are open, pressing the Esc key should close only the last shown dialog." - living - [V]
- S6 - W3C WAI-ARIA Authoring Practices Guide, Dialog (Modal) pattern: Esc closes, Tab is trapped inside, focus returns to the invoker - living - [V]
- S7 - W3C, WCAG 2.2, SC 2.5.8 Target Size (Minimum), AA: 24x24 CSS px, with spacing, equivalent, inline, user-agent and essential exceptions. SC 2.5.5 (AAA): 44x44 - Rec. 2023-10-05 (date [K]) - [V]
- S8 - Google Android Accessibility Help, "Touch target size": 48x48 dp, 8 dp spacing (Material) - living - [V] (via search)
- S9 - Apple Human Interface Guidelines: 44x44 pt hit target - living - [U] (Apple page not reached; secondary sources disagree on whether 44x44 pt is the minimum or the default, with 28x28 pt cited as a minimum)
- S10 - web.dev, "Cumulative Layout Shift (CLS)": good ≤0.1, poor >0.25, measured at p75; shifts within 500 ms of input are excluded via `hadRecentInput`; reserve space up front - living - [V]
- S11 - react.dev, `hydrateRoot`: "treat mismatches as bugs"; the causes include `typeof window` and `window.matchMedia` in render; two-pass render; `suppressHydrationWarning` is one level deep, "an escape hatch" - React 19 docs - [V]
- S12 - react.dev, `useSyncExternalStore`: `getServerSnapshot` "must be the same between the client and the server" - React 19 docs - [V]
- S13 - Next.js docs, "Text content does not match server-rendered HTML": causes include `localStorage`, `Date()`, invalid nesting, extensions and iOS format-detection; fixes are `useEffect`, `dynamic(..., {ssr:false})` and `suppressHydrationWarning` - living - [V]
- S14 - Chrome for Developers, "Page Lifecycle API": persist on `visibilitychange`→hidden (the article calls `pagehide` a weaker place to save), "never use the `unload` event", add `beforeunload` only while unsaved changes exist - 2023-12-01, upd. 2026-10-16 - [V]
- S15 - Floating UI docs: `offset` / `flip` / `shift` / `autoUpdate`, virtual elements for cursor-anchored menus; W3C CSS Anchor Positioning - living - [K] (not re-fetched in the verification pass)
- S16 - Playwright docs, Emulation: `devices['iPhone 13']`, viewport, `isMobile`, `hasTouch`, locale, timezone, colorScheme - living - [V]
- S17 - Nielsen, "10 Usability Heuristics for User Interface Design", NN/g - 1994 (rev. 2020 per secondary sources) - [V] (heuristic numbering checked; revision dates unverified)
- S18 - Klein, G., "Performing a Project Premortem", *Harvard Business Review* - Sept 2007 - [V]
- S19 - Harel, D., "Statecharts: A visual formalism for complex systems", *Science of Computer Programming* 8(3) - 1987 - [K]
- S20 - Claessen and Hughes, "QuickCheck: a lightweight tool for random testing of Haskell programs", ICFP. Model-based or stateful PBT as in fast-check `fc.commands` - 2000 - [K]
- S21 - Norman, D., *The Design of Everyday Things* (affordances and signifiers), revised edition - 1988 / 2013 - [K]
- S22 - Fitts, P. M., "The information capacity of the human motor system…", *J. Exp. Psychology* 47(6) - 1954 - [K]
- S23 - Gawande, A., *The Checklist Manifesto* - 2009 - [K]
- S24 - IEC 60812:2018, Failure Modes and Effects Analysis - 2018 - [K]
- S25 - Basiri et al., "Chaos Engineering", *IEEE Software* 33(3) - 2016 - [K]
- S26 - WHATWG DOM `AbortController`; the stale-response race in fetch-on-change - living - [K]
- S27 - W3C *Resize Observer* - WD - [K]
