---
name: train-compound
description: "Use when the owner types /train-compound or wants many ready branches accumulated into ONE release to {{INTEGRATION_BRANCH}} instead of shipping train by train. Builds a compound integration branch on a fresh {{INTEGRATION_BRANCH}}, boards every READY branch into it with a typecheck and a deploy check after each, keeps the individual PRs complete, and opens one PR to {{INTEGRATION_BRANCH}} that merges only when the owner says to release it."
argument-hint: "[optional: branches/worktrees already ready]"
---

# /train-compound: accumulate, prove, release once

A compound train is the `/train` system with one difference: nothing reaches `{{INTEGRATION_BRANCH}}` until the owner releases it. Every ready branch is merged into one integration branch that always shows "what `{{INTEGRATION_BRANCH}}` would be", and each boarding proves that this branch still deploys.

Read the `train` skill first. Its rules all apply here: READY lines, the heavy slot, the typecheck lane, conflict handling, running CI's checks locally when Actions can't run, never `-X ours` or `-X theirs`. Two of its sections matter even more here, because a compound lives for days:

- **Section 6, the watch:** `mem_map` every round and before every build (the `machine-memory` skill), one sampler for the whole compound.
- **Section 6b, worktree hygiene and the leftovers sweep:** remove boarded worktrees once they're merged and idle, one sweep owner at a time, and run the leftovers sweep after the release.

If this file still has unfilled placeholders (names in double curly braces), fill them the way the `train` skill says.

## 1. Start the compound branch

- Create `train/compound-<yyyy-mm-dd>` from a fresh `origin/{{INTEGRATION_BRANCH}}` in its own worktree (`bash {{JSTACK_TOOLS}}/new-worktree.sh train/compound-<date> --install`). Check it is a real worktree (`[ -f .git ]`) with fresh build and codegen output.
- Write `{{QUEUE_FILE}}` with `mode: compound`, the branch, and an empty boarded list.

Done when: the branch exists and the queue file names it.

## 2. Board each READY branch

For every READY (typecheck green at its head):

1. Merge it into the compound branch, resolving conflicts file by file.
2. Run the integration typecheck (`tc_run "{{TYPECHECK_CMD}}"`), then CI's own suites locally for what the branch touches.
3. Prove the deploy still works: push the compound branch and read its **preview** deploy status once (`gh api repos/<owner>/<repo>/commits/<sha>/statuses`, never a polling loop). If no preview exists, run one capped local build (`heavy_capped`) inside the heavy slot.
4. Red anywhere: drop that branch from the compound (reset to the previous green head), bounce it to its agent with the error lines, and keep going.
5. Keep the branch's own PR complete (`{{PR_TEMPLATE}}` body, How to test with the proofs), but merge it only into the compound branch.
6. Whenever `origin/{{INTEGRATION_BRANCH}}` moves (a hotfix, say), merge it into the compound and prove it again.

Done when: every READY is either boarded with a green typecheck and preview, or bounced with its reason.

## 3. Release on the owner's word

- Keep ONE PR, `train/compound-…` into `{{INTEGRATION_BRANCH}}`, whose body lists every boarded branch, the migrations, env vars and flags, and how to roll back.
- Don't merge it until the owner says to release. Hotfixes the owner marks urgent can still ship alone through the normal `/train` path; merge them back into the compound afterwards.
- On release: merge `origin/{{INTEGRATION_BRANCH}}` one last time, typecheck, preview green, merge, confirm the deploy is Ready and every migration applied, and report one line per boarded branch.
- Then run the leftovers sweep (`train` section 6b) for everything the compound boarded.

Done when: `{{INTEGRATION_BRANCH}}` is Ready on the compound's merge commit, the queue file is reset, and the sweep has reported.

## Lessons

- **A compound grows large:** re-run the full local suites (not only the touched ones) before the release, and read every failure line (the `train` skill's flake rule).
- **Board in dependency order:** branches built on the compound's own new code (a shared kit, and the features on top of it) board after their base, and the dependent ones re-merge the compound head before their READY.
- **The release build may need the file cache emptied first (2026-10-25):** a build that holds the slot waits for `JSTACK_HEAVY_MIN_AVAIL_GB` free (12 GB by default). After a few days of installs, antivirus scans and worktree deletions, the system file cache sat resident at 16.8 GB and the build waited on RAM that no process was holding. Run `mem_map` before the release build; if the cache line is the big one, empty it (the `machine-memory` skill, step 3b, with the owner there for the UAC prompt) and then build. On a 32 GB laptop, half the RAM quietly filled with files nobody had opened in hours. Classic.
