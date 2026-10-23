# Performance know-how for /optimize

The method, numbers and trace recipes /optimize works from. Every line comes from a primary source (list at the end, each with its date). Nothing here is from memory, and anything we could not verify says so.

Credits:

- The method (claim first, explain the number, mantras cheapest first, one change and one measurement, the vetting checklist, trace forensics) is adapted from **pstack** by Lauren Tan (poteto), `perf-issue.md`, `hillclimb.md`, `runtime-forensics.md`, `trace-forensics.md`, `benchmark-checklist` and `principle-explain-the-number`, in [cursor/plugins](https://github.com/cursor/plugins/tree/main/pstack) (MIT, read at commit 4ec7ffa, 2026-10-22). Go read the original, it's better written than this.
- pstack's checklist builds on **Brendan Gregg's** [Benchmarking Checklist](https://www.brendangregg.com/blog/2018-06-30/benchmarking-checklist.html) (2018), his [USE method](https://www.brendangregg.com/usemethod.html) and the performance mantras he credits to Craig Hanson and Pat Crain ([methodology](https://www.brendangregg.com/methodology.html)).

## Method (credit: pstack perf-issue, hillclimb and benchmark-checklist; Gregg)

1. **Write the claim first**, in the words you would ship ("thread open p50 −30% on a 2k-message thread, warm cache").
   Read the timing script and note what it times and what it ignores.
2. **Capture a baseline trace before reading code.** Never plan a fix from source alone.
3. **Name the limiter ("why not double?")** from a profile or from counters taken *during* a run, then map it to file and line.
   Profile in a run you do not report, because profilers slow the work down. For servers, run USE on each resource
   (utilization, saturation, errors). A guess from reading the code is not a limiter.
4. **Apply the mantras in order, cheapest first, and stop at the first one that meets the target:**
   don't do it → don't do it again (cache) → do less → do it later → do it when they're not looking (prefetch/idle)
   → do it concurrently → do it cheaper. "Don't do it" means delete work whose result nothing uses.
5. **Make one change, take one measurement, then keep or revert.** Never stack untested changes. Log every attempt in
   `decision.tsv` (id, hypothesis, change, before, after, delta, tests, verdict). After a plateau, change category and try again
   before stopping, and never relax the stop predicate to meet it.
6. **Interleave the arms (A B A B), with at least 5 runs each** (10 for load metrics on a laptop). Report the median and range,
   and p75 for user metrics. A gap smaller than the run-to-run spread means no difference. Claim "lower" only when the
   Hodges-Lehmann 95% CI of the shift excludes 0 and Cliff's |δ| ≥ 0.147.
7. **Keep behaviour.** Never drop a feature, a permission check or a billed call to win time. Revert a win that breaks
   behaviour, and keep a simplification that holds the number.

## Vet every number before reporting it (Gregg's 7 questions, as extended by pstack)

- [ ] **Why not double?** The limiter is named, from evidence.
- [ ] **Was it tuned?** Both arms ran production builds, production flags, the same data and the same cache state. If not, you compared configs.
- [ ] **Did it break limits?** The saving is ≤ the time the changed piece took (cutting 10% of a run gives at most about 11% faster).
- [ ] **Did it error?** Non-2xx responses and failed requests are counted. Rejections and timeouts make fast or slow fake numbers.
- [ ] **Does it reproduce?** ABAB, n per arm, spread reported, machine CPU and free RAM logged, noisy blocks re-run.
- [ ] **Does it matter?** The end-to-end user wait (load, click-to-drawn, next click, phone viewport) is measured, not only the micro metric.
- [ ] **Did it even happen?** The request reached the server, the rows were written and the promise was awaited inside the timed region.
- Verdict: faster, slower, no measurable difference or **inconclusive**. It is inconclusive when the limiter is unknown, a side was untuned,
  or errors or "did it happen" were not checked. Write the number with its unit, n, range and limiter.

## Metrics and targets (p75, mobile and desktop separately)

| Metric | Good | Poor | Notes |
|---|---|---|---|
| LCP | ≤ 2.5 s | > 4 s | field + lab |
| INP | ≤ 200 ms | > 500 ms | field only; in the lab, report scripted click → paint as "lab INP" |
| CLS | ≤ 0.1 | > 0.25 | |
| TTFB | ≤ 0.8 s | > 1.8 s | not a Core Web Vital; ignores 103 Early Hints if measured from `finalResponseHeadersStart` |
| FCP | ≤ 1.8 s | > 3 s | |
| Long frame | > 50 ms | n/a | LoAF `scripts[].sourceURL/invoker/blockingDuration` names the culprit |
| Soft navigation (SPA route change) | treat like a load | n/a | Chrome 151+ by default; `web-vitals` `reportSoftNavs: true` |
| Perception | < 100 ms feels instant; < 1 s keeps flow | > 10 s loses attention | Nielsen; GitHub counts < 200 ms as "instant" |

## Trace recipes (capture → queryable → query)

Always reduce an artifact to rows (sqlite or Perfetto SQL) before reading it. Parse big artifacts in a subagent. A frame
without a source mapping is not a diagnosis. Without a paired before/after capture, call the finding "strongest hypothesis".

- **Browser load or click:** CDP `Tracing.start` (or DevTools MCP `performance_start_trace`) → Chrome JSON trace →
  Perfetto Trace Processor, `SELECT name, SUM(dur) FROM slice GROUP BY name ORDER BY 2 DESC LIMIT 20`.
  Pair it with a Playwright trace for actions and network (a Playwright trace has no CPU profile).
- **Main-thread blame:** `new PerformanceObserver(l => …).observe({type:'long-animation-frame', buffered:true})` → rows of
  (sourceURL, invoker, blockingDuration). Match them to the slow interaction by time window.
- **Field:** `import {onINP, onLCP, onCLS} from 'web-vitals/attribution'` → one row per event with route, device, `inputDelay`,
  `processingDuration`, `presentationDelay`, `longestScript` and `interactionTarget`.
- **React:** alias `react-dom/client` → `react-dom/profiling` in a production build. React Performance Tracks (Scheduler +
  Components) then show inside the DevTools trace. Use `<Profiler onRender>` rows (actualDuration vs baseDuration).
  Use React Scan for wasted re-renders (dev or preview only).
- **Server (Node):** `node --cpu-prof --cpu-prof-dir=<dir>` on the production server, under load → `.cpuprofile` (JSON nodes + samples)
  → sqlite or Perfetto. Or use `0x` for a one-command flamegraph. Avoid clinic.js (unmaintained, the README says results may be wrong).
- **Request breakdown:** emit `Server-Timing: auth;dur=12, db;dur=53, render;dur=40` (authenticated responses only) and read it
  from `performance.getEntriesByType('navigation'|'resource')[i].serverTiming`.
- **Spans:** OpenTelemetry (Next.js: `instrumentation.ts` → `registerOTel`, `NEXT_OTEL_VERBOSE=1`; ORM spans such as
  `prisma:engine:db_query`) → export as JSON → one row per span (traceId, parent, name, start, dur). Count DB spans per
  request to find N+1 queries. Use batch export and sampling in production.
- **Database:** `pg_stat_statements` snapshot before and after, diffed by `queryid`, ordered by `total_exec_time`. Then
  `EXPLAIN (ANALYZE, BUFFERS)` the top queries (wrap DML in `BEGIN … ROLLBACK`; ANALYZE executes the statement).
- **Load tests:** use a constant arrival rate and latency from the intended send time (wrk2/HdrHistogram). Closed-loop tools
  hide stalls (coordinated omission: p99 6 ms reported vs 1.27 s real in wrk2's example).

## Techniques for instant screens and chat (try in this order)

1. **Render from local data, then revalidate.** Use a memory + IndexedDB cache with SWR, and preheat it from list views. Race the
   cache read against the network (GitHub Issues: P10 600→70 ms, instant navigations 4%→22–70%; Notion: navigation −20%).
2. **Prefetch on intent.** Use viewport, hover (about 65 ms of hover ≈ 50% click chance) or pointerdown. Next.js `<Link>` and `router.prefetch`;
   TanStack Query with a `staleTime` set (prefetch is a no-op on fresh data). For MPA navigations, use Speculation Rules
   `prefetch` + `conservative` (Shopify: −220 ms median desktop for +0.7% traffic). Prerender only when analytics and stale-content risk are handled.
3. **Make writes optimistic.** `useOptimistic` / `onMutate` → rollback `onError` → invalidate `onSettled`.
4. **Kill waterfalls.** Hoist fetches to the route or parent and run them in parallel. Stream the shell with Suspense.
5. **Window long lists.** Use virtualization with a reverse/chat mode, recycle rows, inflate rare widgets lazily, and page older messages on demand.
6. **Free the main thread.** Split tasks over 50 ms (`scheduler.yield()`), defer only the heavy subtree, and keep keystroke state local.
7. **Ship less JS before first use.** Lazy-load what isn't on screen and load caches and WASM fully async, because a new cache layer can regress the load.
8. **Compress and cache API responses.** Measure gzip vs brotli on your own JSON; no trustworthy generic number exists.

## Report

Lead with the verdict. Then a table per surface with before median (p75), after median (p75), shift and 95% CI, Cliff's δ and n.
Add the bytes table, the machine state, the limiter, the `decision.tsv` path, what stays slow and why, and the next idea you would try.

## Old rules and how they aged

- **Souders' 14 rules** (High Performance Web Sites, 2007): caching, compression and a CDN still hold. Concatenation and domain sharding got contested once HTTP/2 arrived; one study (Marx et al., WEBIST 2017) still measured them helping in many h2 cases. Re-measure your bundling instead of trusting either camp.
- **RAIL** (100 ms response, 50 ms chunks, 10 ms frames): web.dev now says Core Web Vitals is the recommended approach "over RAIL". The 50 ms chunk survives as the long task and Long Animation Frame threshold.
- **PRPL** (preload, render the first route, pre-cache, lazy load): it lives on as route splitting plus prefetching, and pre-caching moved to service workers.
- **USE and the mantras**: aged fine. Still the fastest way to find a server bottleneck and to order fix ideas.

## Sources (date shown on the page, or "read" when the page has none; all read 2026-10-23)

- Core Web Vitals, p75 rule: https://web.dev/articles/vitals (2024-10-31); INP: https://web.dev/articles/inp (2025-09-02); TTFB: https://web.dev/articles/ttfb (2025-11-18); LCP/CLS/FCP: web.dev/articles/{lcp,cls,fcp}
- Long Animation Frames: https://developer.chrome.com/docs/web-platform/long-animation-frames (2024-10-14); long tasks: https://web.dev/articles/optimize-long-tasks (2024-12-19)
- Soft navigations (default from Chrome 151): https://developer.chrome.com/docs/web-platform/soft-navigations-experiment (2026-10-20); web-vitals: https://github.com/GoogleChrome/web-vitals (v5)
- Response time limits: https://www.nngroup.com/articles/response-times-3-important-limits/ (1993, updated 2014)
- The Tail at Scale, Dean and Barroso, CACM 2013: https://research.google/pubs/the-tail-at-scale/
- RMIT, Abedi and Brecht, ICPE 2017 (identical systems "differ by 38%" without interleaving): https://research.spec.org/icpe_proceedings/2017/proceedings/p287.pdf
- Mytkowicz et al., "Producing wrong data without doing anything obviously wrong!", ASPLOS 2009; Kalibera and Jones, "Rigorous Benchmarking in Reasonable Time", ISMM 2013
- Mann-Whitney in Chromium's bisect: https://codereview.chromium.org/1610203003 (2016); Hodges-Lehmann: https://aakinshin.net/posts/hodges-lehmann-efficiency1/ (2022-05-17)
- Coordinated omission, wrk2: https://github.com/giltene/wrk2
- Lighthouse CI: https://github.com/GoogleChrome/lighthouse-ci; scoring and variance: https://developer.chrome.com/docs/lighthouse/performance/performance-scoring
- RAIL: https://web.dev/articles/rail (2020-06-10); PRPL: https://web.dev/articles/apply-instant-loading-with-prpl (2018-11-05)
- Perfetto Trace Processor: https://perfetto.dev/docs/analysis/trace-processor; other formats: https://perfetto.dev/docs/getting-started/other-formats
- Chrome DevTools MCP: https://developer.chrome.com/blog/chrome-devtools-mcp (2025-09-23); Playwright tracing: https://playwright.dev/docs/api/class-tracing
- React Profiler: https://react.dev/reference/react/Profiler; Performance Tracks: https://react.dev/reference/dev-tools/react-performance-tracks; React Scan: https://github.com/aidenybai/react-scan; useOptimistic: https://react.dev/reference/react/useOptimistic
- Node `--cpu-prof`: https://nodejs.org/api/cli.html; 0x: https://github.com/davidmarkclements/0x; clinic.js (unmaintained): https://github.com/clinicjs/node-clinic
- Server-Timing: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Server-Timing (2026-07-28)
- Next.js OpenTelemetry: https://nextjs.org/docs/app/guides/open-telemetry (2026-10-22); prefetching: https://nextjs.org/docs/app/guides/prefetching (2026-10-05)
- Prisma tracing: https://www.prisma.io/docs/orm/prisma-client/observability-and-logging/opentelemetry-tracing
- pg_stat_statements and EXPLAIN: https://www.postgresql.org/docs/current/pgstatstatements.html, https://www.postgresql.org/docs/current/using-explain.html (PostgreSQL 18)
- Speculation Rules: https://developer.chrome.com/docs/web-platform/prerender-pages (2026-01-23); Shopify numbers: https://shopify.dev/docs/storefronts/themes/best-practices/performance/use-speculation-rules
- TanStack Query prefetching: https://tanstack.com/query/latest/docs/framework/react/guides/prefetching; TanStack Virtual: https://tanstack.com/virtual/latest; instant.page: https://instant.page/
- GitHub Issues: https://github.blog/engineering/architecture-optimization/from-latency-to-instant-modernizing-github-issues-navigation-performance/ (2026-05-14)
- Notion WASM SQLite: https://www.notion.com/blog/how-we-sped-up-notion-in-the-browser-with-wasm-sqlite (2024-07-10)
- Discord mobile lists: https://discord.com/blog/supercharging-discord-mobile-our-journey-to-a-faster-app (2025-03-05)
- Slack desktop rewrite: https://slack.engineering/rebuilding-slack-on-the-desktop/ (2019-07-22)
- Vodafone: https://web.dev/case-studies/vodafone (2021-03-17); redBus: https://web.dev/case-studies/redbus-inp (2023-05-10)
- Google "Speed Matters" (100 to 400 ms delay, 0.2 to 0.6% fewer searches): https://research.google/blog/speed-matters/ (2009)
- Deloitte "Milliseconds make millions" (commissioned by Google, correlational): https://www.deloitte.com/ie/en/services/consulting/research/milliseconds-make-millions.html (2020-03-24)
- Not verified, so not used as fact: Amazon "100 ms = 1% of sales" (not on the cited page), Netflix "-50% TTI" (secondary only), any primary Linear, Figma or WhatsApp Web latency number.
