# Sources: CI, build, tooling and git/train hygiene

Carried over from the research pass of 2026-10-25 (`02-research-ci-build-git.md`), product-specific lines removed. Each line keeps the tag it had there: **[V]** checked against the primary page in that pass; **[K]**, **[B]**, **[C]** or **[M]** a known citation (author, year, venue) not re-opened; **[U]** unverified, treat as a hypothesis. Lines without a tag were cited with their venue and date only.

- S1 - Graydon Hoare, "The Not Rocket Science Rule of Software Engineering" ("automatically maintain a repository of code that always passes all the tests"; origin of bors / merge queues) - blog (graydon2.dreamwidth.org/1597.html), 2014 - [U] page returned 403 and no mirror found in a second pass; wording is a paraphrase
- S2 - GitHub Docs, "Managing a merge queue": "The merge queue will ensure the pull request's changes pass all required status checks", checked against base + PRs ahead in the queue - docs, current - [V]
- S3 - Ananthanarayanan et al., "Keeping Master Green at Scale" (Uber SubmitQueue) - EuroSys 2019 - [V]
- S4 - Memon et al., "Taming Google-Scale Continuous Testing" - ICSE-SEIP 2017, pp. 233-242 - [V]
- S5 - Luo, Hariri, Eloussi, Marinov, "An Empirical Analysis of Flaky Tests" (async wait, concurrency, order dependency) - FSE 2014 - [V]
- S6 - Git docs, `merge-strategies`: `-X ours` "forces conflicting hunks to be auto-resolved cleanly by favoring our version"; `-X theirs` the opposite - git-scm.com - [V]
- S7 - Git docs, `git-worktree`: `remove`, `prune --dry-run`, `list --porcelain` (stable for scripts, `prunable` annotation), `lock` - git-scm.com - [V]
- S8 - Hyrum's Law: "all observable behaviors of your system will be depended on by somebody"; also in Winters, Manshreck, Wright, *Software Engineering at Google* (O'Reilly 2020) - hyrumslaw.com; book 2020 - [V] / [K]
- S9 - Ian Robinson, "Consumer-Driven Contracts: A Service Evolution Pattern" - martinfowler.com, 12 Jun 2006 - [V]
- S10 - TypeScript wiki "Performance": `--extendedDiagnostics`, `--generateTrace` + `@typescript/analyze-trace`, `--explainFiles`, `incremental`, project references ("5-20 projects is an appropriate range"), "Adding type annotations, especially return types, can save the compiler a lot of work" - github.com/microsoft/TypeScript/wiki - [V]
- S11 - Vercel Docs, "Managing Builds": machine table (Basic 2 vCPU/8 GB, Standard 4 vCPU/8 GB, Enhanced 8 vCPU/16 GB, Turbo 30 vCPU/60 GB, Elastic 4-30 vCPU/8-60 GB, default for new Pro/Enterprise teams); Build Diagnostics - docs, updated 2026-09-17 - [V]
- S12 - GitHub Docs, Actions billing: without payment method "usage is blocked once you use up your quota"; opt-in email alerts at 90% and 100% of included usage; larger runners always blocked without a payment method - docs, current - [V] (docs do not say whether blocked jobs queue or fail)
- S13 - Anthropic, "Building Effective Agents": "finding the simplest solution possible, and only increasing complexity when needed"; ground truth from the environment each step; stopping conditions; human checkpoints - anthropic.com, 19 Dec 2024 - [V]
- S14 - Claude Code Docs, "Skills": personal `~/.claude/skills/<name>/SKILL.md`, project `.claude/skills/<name>/SKILL.md`, plugin `<plugin>/skills/<name>/SKILL.md`; precedence enterprise > personal > project; plugin skills namespaced - code.claude.com/docs/en/skills - [V]
- S15 - Martin Fowler, "Continuous Integration" (orig. 2000, rev. 2006, rev. 2024): every commit builds and tests on mainline; fix broken builds immediately; keep the build fast - martinfowler.com - [K]
- S16 - Humble & Farley, *Continuous Delivery* - Addison-Wesley 2010 - [K]
- S17 - Forsgren, Humble, Kim, *Accelerate* (DORA: lead time, deploy frequency, change-fail rate, MTTR; small batches, trunk-based) - IT Revolution 2018 - [K]
- S18 - Beyer et al., *Site Reliability Engineering* (monitoring, "Eliminating Toil", dependency monitoring); *The Site Reliability Workbook* (2018) - O'Reilly 2016 / 2018 - [K]
- S19 - Gary Klein, "Performing a Project Premortem" - Harvard Business Review, Sep 2007 - [K]
- S20 - Atul Gawande, *The Checklist Manifesto* (DO-CONFIRM vs READ-DO; pause points; 5-9 items) - Metropolitan 2009 - [K]
- S21 - J.D.C. Little, "A Proof for the Queuing Formula L = λW" - Operations Research 9(3), 1961 - [K]
- S22 - Donald Reinertsen, *The Principles of Product Development Flow* (batch size, WIP, cost of delay, queues are invisible) - Celeritas 2009 - [K]
- S23 - Kent Beck, *Extreme Programming Explained* (YAGNI, ten-minute build) - Addison-Wesley 1999 / 2nd ed. 2004 - [K]
- S24 - Bertrand Meyer, "Applying Design by Contract" - IEEE Computer 25(10), 1992 - [K]
- S25 - D. L. Parnas, "On the Criteria To Be Used in Decomposing Systems into Modules" - CACM 15(12), 1972 - [K]
- S26 - Michael Nygard, "Documenting Architecture Decisions" (ADRs) - blog, Nov 2011 - [K]
- S27 - Potvin & Levenberg, "Why Google Stores Billions of Lines of Code in a Single Repository" (presubmit, large-scale changes run against all callers) - CACM 59(7), 2016 - [K]
- S28 - Git docs, `githooks` / `git commit --no-verify` (bypasses pre-commit and commit-msg hooks) and GitHub "About protected branches" (required status checks, "Do not allow bypassing the above settings", admin bypass) - docs - [K]
- S29 - Node.js CLI docs `--max-old-space-size`; Next.js "Memory Usage" guide (`--experimental-debug-memory-usage`, disabling production source maps, webpack memory optimizations) - docs - [K] for Node; [U] for exact Next 16 flag names, re-check `node_modules/next/dist/docs/`
- S30 - Phil Karlton (attrib.), "There are only two hard things in Computer Science: cache invalidation and naming things"; Bazel docs on hermeticity and content-addressed caching - folklore, date unknown / bazel.build - [U] attribution and date / [K] Bazel
