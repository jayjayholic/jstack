# Debug checks for /optimize

The checklist every run starts from. Each row: what you see, how to measure it, the likely cause, the fix that was
proven, how to verify. Every row came from a real run on a Next.js 16 app on a Windows laptop with too little RAM for
the number of agents on it; the classes travel to any web app.

Use it three times per run: **before the baseline** (method and machine traps), **when ranking** (known causes), and
**whenever a number looks wrong** (a click under 20 ms, a metric moving on identical code, an empty panel).

## 1. Method traps: the numbers lie

| Symptom | How to measure | Cause | Fix | Verify |
| --- | --- | --- | --- | --- |
| Every click scenario times out | 1-run smoke of the suite (`{{SUITE_SCRIPT}} <url> <session> probe <dir> 1`) | a UI redesign renamed the selectors the suite targets | probe the live page (first appearance of each `data-testid` after load, a screenshot), update the selectors | the smoke passes every scenario |
| A click "arrives" in < 20 ms, or before the click (negative) | click → target near 0 with no paint change | the done-signal already matches the screen being left (its bubbles, its header) | the done-signal must be a NEW element, absent at the click: snapshot matching nodes before clicking, count only new ones | the metric moves with the real paint |
| Block dies with `TimeoutError … intercepts pointer events` | read the whole error, not a filtered log | an overlay (dialog scrim, "What's new") covers the target; Escape closes only the top layer | list every overlay selector, press Escape until none is left | the block completes |
| TBT rises after a fix that paints earlier | compare TBT with total long-task time and LoAF blocking | TBT counts long tasks after FCP only; an earlier FCP pulls hydration into the window | judge main-thread cost by window-independent totals | totals flat, FCP lower |
| INP improves although the page froze for seconds | inputs that got in, longest frame, frames per second | during a freeze few inputs land, and they land between frozen frames | for freezes report inputs-in, longest frame, fps, not INP | before/after of all three |
| Moving work behind the paint looks like a win | INP vs blocking frames vs click → drawn vs the click's API end | deferral moves work, it does not remove it; deferred fetches start later | report all four | none of the others got worse |
| Identical code, "lower" in one scenario, "higher" in another | the same page loaded by several scenarios in one A/B | block drift (±150 ms per block on a shared laptop) | claim a load shift only when ≥ 2 scenarios agree; repeat the ABAB | same direction twice |
| A fix cannot be A/B'd | one run of the exact scenario on the local data before writing the fix | the target is not reachable in the test data (paged out, absent) | pick reachable data, or revert the fix unmeasured | the scenario clicks the target |
| The measured entity is not the one you meant | log which row the click opened per run | "the first row" depends on viewport and data order | name the target and put it in the run label | the label names it |
| 6–25 s TTFB outliers on staging | TTFB per run, warm-ups included | serverless cold instance | discard the warm-up; drop cold-instance runs from a warm median and say so | p95 stops jumping |
| Staging CPU the product never runs | the worst frames' script URLs | preview-only scripts (deploy toolbar, session recorder) | subtract them, don't fix them | the production trace has none |
| Arms differ in data, not code | errors in the server log per block | a shared test DB changed under you (another branch's enum value broke a list in both arms) | both arms in one data state, one sitting | no errors in either arm |
| An empty panel, and every number after it lies | call one API route with the session cookie, read the server log | a failing request (session minted under another env, schema drift) | fix the setup before measuring | every panel draws |
| Staging redirects to sign-in | the stored session's cookie expiries | the session expired | ask the human to sign in again; never type credentials | a probe loads the app |

## 2. Machine and tooling traps

| Symptom | How to check | Fix |
| --- | --- | --- |
| RAM at 2–9 %, a build or server killed | free memory, the heavy-slot lock, the build processes' command lines | one build at a time: `source {{JSTACK_TOOLS}}/heavy-lock.sh; server_wait 8; heavy_acquire optimize; heavy_capped …; heavy_release`; a build you did not start is someone else's: read its command line before blaming or killing it |
| Builds, A/Bs or polls die when the agent pauses or hits a limit | the background task output | chain every arm in ONE script run as one background task (lock, cap, label `ARM`, move the build out); the A/B the same way |
| An arm's build is missing or mislabelled at A/B time | `cat <build>/ARM <build>/BUILD_ID` for every arm before the first block | label at build time, move with `mv` (never `cp -r`: it breaks symlinks inside the build) |
| `ERR_CONNECTION_REFUSED` on a server you started | `curl` the port | start the server as a background task, never `( … &)` inside a call; `until curl -s …` before measuring |
| Port serving someone else's build | `netstat -ano` for the port; the build id in the page's asset URLs | one server at a time on a free port; stop it right after |
| Typecheck exits 1 with no type error | the capped run's memory peak | rerun; it was the memory cap |
| Two builds running elsewhere, timings swing 0.2–3 s on identical code | CPU and free memory per run | ship the deterministic numbers (bytes, rows, payload) and leave the timing re-run as a command |
| `until` loop prints `integer expression expected` | run the test alone | `grep -c` prints `0` and exits 1, so `$(grep -c … \|\| echo 0)` yields `0\n0`; use `n=$(grep -c x f 2>/dev/null); [ "${n:-0}" -ge N ]` |
| `node -e` dies on a regex or quote | — | write analysis scripts to files (`<<'EOF'` heredoc), pass paths as arguments |
| `/route` becomes `C:/Program Files/Git/route` | — | `MSYS_NO_PATHCONV=1`; give node `C:/…` paths |
| `psql` through a nested `bash -c` fails on quoting | — | `docker exec <container> psql -U <user> -d <db> -At -c '…'` directly |
| Need the current measurement scripts but no worktree is left | — | `git show origin/<branch>:<script>` (and its imports) into a cache folder; run from the main checkout |
| Cleanup fails with `Filename too long` | — | Windows: `Remove-Item -LiteralPath '\\?\C:\…' -Recurse -Force` in the background, then `git worktree prune` |
| A long staging baseline blocks the run | — | start it in the background first (8 scenarios × 10 runs ≈ 30 min); read traces and code meanwhile |

## 3. Known causes, cheapest check first

| Symptom | How to measure | Likely cause | Proven fix | Verify |
| --- | --- | --- | --- | --- |
| Big HTML, slow stream, late FCP | fetch the HTML with the session; decode the RSC flight rows (`self.__next_f`; rows are `id:JSON` or `id:T<hexlen>,<text>`; the dehydrated React Query state starts at `"state":{"mutations":[],"queries":`); list queries by size | a query nobody draws on load is dehydrated (a 210 KB list for a hidden pane) | drop it from the server preload; prefetch it on idle | document KB lower (deterministic) |
| FCP ≈ hydration, far after `domInteractive` and CSS end | resource timing, then grep the server HTML for `opacity:0` / `visibility:hidden` around the content | a page-transition wrapper starts invisible (`motion` `initial: {opacity: 0}`) | `AnimatePresence initial={false}`: the first page paints from the HTML, later route changes still animate | FCP lower in every load scenario |
| Idle network/CPU after load | list idle prefetches and `import()` calls against what each screen renders now | a warm-up for a retired screen | warm what the current screens draw; delete the dead screen | click → content lower, bytes lower |
| Click INP ≫ click → drawn | a trace around the click: one long task containing `EventDispatch click` | the click's state comes from `useSyncExternalStore` or a sync update, so the whole next screen renders inside the click | the heavy subtree follows `useDeferredValue` of the selection; keep light screens synchronous | INP lower, drawn not much later, other clicks unchanged |
| A tab click freezes | same trace; effects inside the click's task | a heavy mount (WebGL, big list) in effects React flushes before the paint of a discrete event | `useDeferredValue` on that tab only (deferring every tab slowed the light ones ~56 ms) | heavy tab INP lower, light tabs unchanged |
| An in-page screen change waits on the server | RSC requests after the click | `router.push('?x=')` on a dynamic page is a server navigation | `history.pushState` for in-page state (Next keeps `useSearchParams` in step) | 0 RSC requests on the click |
| Screen blank for one round trip after a click | the calls that start after the click; which one gates first paint | a check or the screen's data read only on click | read it on idle, hover or press with the same query key | click → drawn lower |
| A list payload is huge for few rows | bytes per field in the DB (`octet_length`) | fields no reader draws (tool results, logs) shipped with every row | a lean row for the client with an explicit "left out" marker, never a silent cut | payload lower, same rows drawn |
| "It loads everything at once" | check the paging before changing it | it is paged; each row is heavy | shrink per-row bytes first, then the first page | bytes per page |
| Reload redraws slowly though the data was seen | is a kept copy drawn before the read? | cache only in memory | keep the latest page per item (bounded, cleared on sign-out); draw it, read fresh, redraw only if changed, keep live updates | reload → content lower, live updates still arrive |
| Streaming output freezes the page, worse the longer it gets | CPU profile during a scripted stream at a fixed pace | per-piece work over the whole content (re-highlight, re-parse): quadratic | keep processed state, process only what was added; defer the parse | longest frame, inputs-in, fps |
| Server call slow, queries fast | `Server-Timing` per call, `EXPLAIN (ANALYZE, BUFFERS)` | round trips and waits, not the DB | parallelise, cut a step, cache | server ms p50 |
| A headless CLI/agent step slow before it starts | process start → init → first output | user hooks, MCP servers, plugins started per run; result read on exit | lean session flags; read the result event; a pre-started spare | start → first output |
| Every LLM turn pays the full prompt again | cache read/write tokens on the first call | per-turn blocks (clock, place) before the cacheable prefix | move changing blocks after the cache breakpoint | cache read > 0 on fresh turns |
| A faster load made the next click slower | measure the next click with every load fix | work moved from load to first use (a modal mounted on first click) | mount it closed on idle | the next click unchanged |
| A screen change blanks the whole UI (header, background, input gone) | keep a shell selector across the transition and assert it never disappears; trace the click | a pending gate or check rendered "blank" in place of the whole view, and the click rendered every item synchronously | a check never replaces the shell: it waits inside the content slot with a skeleton; the click commits only the shell (React `useDeferredValue(items, [])`); keep the likely next screens warm (latest ~20 rows per recent thread, on idle) | shell remounts 0; click → shell ≤ 100 ms |
| A list shows up seconds late on some loads (p75 far above median) | fetch the page HTML N times and look for the rows; list every API call the region reads | only part of what the region reads is in the server preload; a preload raced a fixed budget and a miss was re-read by the browser after hydration; per-row lookups (N+1) | preload every call the first screen draws from; stream each late read in its own boundary; batch per-row lookups into one query; skeleton rows in place | rows in the HTML on every load; first list content ≈ shell time |
| Every local A/B run times out on the first page load | free memory and CPU in each sample line | the machine was swapping (other agents' typechecks and builds) | measure only with ≥ 35% RAM free and nothing heavy running; otherwise prove on staging after release | free RAM logged per sample, low-RAM samples discarded |

## Adding a row

A new finding goes here during the run, in the right table, generic (the class, an app name only as an example), all
five cells filled; its story and numbers go to `{{PLAYBOOK_FILE}}`. A row whose cause can no longer happen is deleted,
not kept as history.
