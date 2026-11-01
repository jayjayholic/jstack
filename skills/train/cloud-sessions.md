# Cloud sessions: the rules that keep them honest

Reference for `/train` section 8. Read it before you start a cloud worker, a cloud train, a watcher that resumes sessions, or anything that reacts to an account switch. Every rule says what to do, why, how it failed when nobody did it, and the command or test that proves it holds. "Unverified" means seen once, or never tested end to end; treat it as a guess until your own run shows it.

Words used below: a **cloud session** is one Claude Code session on a cloud VM, working on one branch. Each session pushes to its own **session branch** (`claude/*`). The **registry** is the local file that tracks sessions (branch, session id, account, state). The **watcher** is any long-lived local process that polls sessions and resumes them. The **account switcher** is the `jay-claude-switcher` plugin (or whatever moves your local login between accounts). The **integration branch** is `{{INTEGRATION_BRANCH}}`.

## 1. One train session, and nothing resumes it but you

- **Never auto-resume a `train/*` branch.** Watchers, on-switch handlers and stall rules skip every `train/*` entry; the owner starts the train session on purpose and restarts it on purpose.
  - Why: the train merges to the integration branch. A second train session that thinks it is the train will assemble and merge again.
  - Failure: a watcher still running old code resumed the train branch three times in ten minutes. One stray finished its run and merged a PR with zero changed files, a re-merge of a train that had already landed.
  - Check: a unit test that feeds the resume picker a registry with a wrapped, timed-out and stalled `train/live` entry and expects no resume target. The jstack autocommit skips `train/*` too (`cloud-kit.test.mjs`, "train branch").
- **One train session at a time, proved before every merge.** The train writes its own session id into the train PR body (`train-session: <id>`). Before merging, the merger reads the body back and compares it with the session it started: `gh api repos/<owner>/<repo>/pulls/<n> --jq .body | grep -F "train-session: <id>"`. No match: stop, list the sessions on `train/*`, stop the strays.
  - Also refuse an empty train: `gh api repos/<owner>/<repo>/pulls/<n> --jq .changed_files` must be above 0.
- **Merge in two phases.** Phase 1, the dry run: assemble, run every gate, push, open the PR, print `DRY RUN OK <pr> @ <head sha>`, merge nothing. Phase 2, `GO <n>` from the owner or the coordinator, carrying that sha. Before the merge call, `gh api repos/<owner>/<repo>/pulls/<n> --jq .head.sha` must equal the GO sha. Anything moved in between: back to phase 1.
- **Long-lived watchers run the code you think they run.** A watcher records its source's git blob or commit at start (`git rev-parse HEAD:<path to watcher>`, first line of its log) and exits when the checkout's copy changes, so the scheduler restarts it on the new code. Check: the first log line names the sha; after a fix lands, the next line in the log is a restart.
  - Failure: the train-branch skip was already merged, and the watcher started before it kept resuming the train anyway.

## 2. The registry survives concurrent writers

- **Lock, atomic write, merge per id.** Every read-modify-write takes a lock file (`open(path + '.lock', 'wx')`, treated as stale after a fixed age), re-reads the file under the lock, merges the writer's entries into the current ones per id (the newer change wins; a `done` entry stays done unless a newer start replaced it; nobody's entry is dropped), writes a temp file and renames it over the original.
  - Why: several agents and the watcher write the same file. Read, change, write without a lock means the last writer wins with a stale copy.
  - Failure: two writers each read the registry, each added their own session, and the second save erased the first's entry. The lost session was never polled, wrapped or resumed.
  - Check: a test that starts 20 processes, each adding a distinct id at the same moment, and expects 20 entries; plus a test that a stale copy cannot flip a `done` entry back to running.

## 3. Account rotation

Applies only with several stored accounts and a usage source. With one account, skip this section.

- **Wrap up at 95%, before the limit.** At 95% (and when usage is unknown, which fails safe), message every open session on that account to stop at a safe point, commit, push, archive its transcript and debug artifacts (section 9), and publish a `wrapped` handoff.
  - Why: an account at its limit cannot run a turn, and the wrap-up is a turn. At 100% the session just stops wherever it is.
  - Check: a unit test of the decision at 94%, 95% and unknown (wrap, wrap); the watcher logs one decision line per tick.
- **Move sessions on a switch only when the old account is really at its limit.** The account switcher passes `--trigger out|freed|manual` to the on-switch hook (`~/.jstack/cloud-kit.json` `onSwitch`). Only `out` can mean "blocked", and the handler still checks a fresh usage reading of the old account (at or above the threshold) before it resumes anything.
  - Failure: a balance switch (`freed`) moved every session of an account that could still run turns, and each branch ended up with two live sessions pushing over each other.
  - Check: a test with `trigger=freed` and with a fresh 60% reading expects 0 resumes and one trace line `resumed=0 (<why>)`.
- **Messages go out as the session's own account.** A cloud session takes messages only from the account that started it. Send with that account's stored login in a throwaway config dir (`CLAUDE_CONFIG_DIR=<temp>`), never by moving the local login; write a rotated token back to the store.
  - Check: the active login before and after a message is the same (`switch-trace.log` gets no switch line from the message).
- **A plugin change does nothing until the plugin reloads.** A running Claude Code keeps the old module. After updating the account switcher, run `/reload-plugins` in every running instance (or restart them).
  - Failure: the on-switch hook shipped, the next switch fired nothing, because every open instance still ran the version without it.
  - Check: `switch-trace.log` shows a `start version=<new>` line from each instance after the update, and the next `hook on-switch started` line carries `trigger=`.

## 4. A resumed session brings the old session's commits in first

- Each cloud session pushes to its own `claude/*` branch. The resume prompt names that branch, and the new session merges it before it does anything else: `git fetch origin <old claude branch> && git merge --no-edit FETCH_HEAD` (a plain merge: `--ff-only` fails as soon as the work branch moved, and the agent then tends to skip it).
  - Failure: a resumed session started from the work branch alone; the old session's last commits sat on its `claude/*` branch and were lost to the new work.
  - Check: before the resumed session's first push, `git merge-base --is-ancestor origin/<old claude branch> HEAD` exits 0. A resume helper should run it and refuse to report `running` until it does.

## 5. The train worktree gets real dependencies

- In the cloud train, the train worktree takes `node_modules` from the session checkout as hardlinks (`cp -al <checkout>/node_modules <train>/node_modules`, same filesystem, no bytes copied), falling back to a frozen install. Never a symlink.
  - Why: Turbopack refuses a `node_modules` symlink that points outside the project root, so the build fails before it starts.
  - Check: `[ ! -L <train>/node_modules ]`, and a file inside has a link count above 1 (`stat -c %h <train>/node_modules/<any package>/package.json`).
  - On the laptop the shared-store links from `worktree-deps.mjs` stay as they are; this is about a build that refuses links leaving the root.

## 6. A gate counts its results against its input

The `/train` lesson "A parallel gate must count its results against its input list" holds in the cloud too, and the cloud train's gates go through the same rule: each child exits 0 or 1 and writes its own result line, children get `</dev/null`, and the gate fails naming every file without a result. Check: the gate prints `<results>/<inputs>` and fails when they differ.

## 7. No raw TCP out of the VM

- The cloud VM reaches the outside through an HTTPS proxy. Plan for HTTPS and WebSocket only. A database, cache or SSH host outside the VM needs its HTTPS or WebSocket API, or a WS bridge you run next to it.
  - Failure: a query to a database outside the VM hung for over two minutes, while the same database answered from the laptop. It looked like an IP allowlist; it was the transport.
  - Check: `node {{JSTACK_TOOLS}}/cloud/tunnel.mjs start <host:port>` prints `CONNECT 200` for the target, or don't use the tunnel for it.
  - **Unverified:** `tunnel.mjs` (CONNECT through the proxy to a non-HTTPS port). It got a 200 once and hung elsewhere. Use the services' own VMs (the session's Postgres and Redis) or HTTPS APIs first.

## 8. What the cloud will not do for you

- **Branch deletions:** the cloud's GitHub proxy refuses them (and tag pushes, and GraphQL; use REST through `gh api`). Clean up `claude/*` branches from the laptop, only the ones your tooling recorded as created by it. Check: after `done`, `git ls-remote origin 'refs/heads/claude/*'` no longer lists that session's branch.
- **Folder trust:** `claude --cloud` starts from a local folder and stops at "Do you trust this folder?" for a folder never trusted, and nobody answers it inside a pseudo-terminal. Trust each repo (and each worktree root not covered by a trusted parent) once, by hand: `cd <folder> && claude`, answer Yes. Never automate the answer. Check: before `start`, read `~/.claude.json` and confirm `projects["<folder>"].hasTrustDialogAccepted` is true for the folder or a parent; stop with that fix if not.
- **A session idle on an approval expires.** A prompt nobody answers holds the session until the VM pauses or is reclaimed, and background processes die with it. Cloud tasks run without prompts they cannot answer, and the watcher treats "no activity and no checkpoint for 30 minutes" as stalled: one message ("say what you are waiting on"), then a fresh resume from the last checkpoint. Check: a test of the stall rule (no heartbeat for 10 minutes, or no activity for 30, gives `stalled`; a long build with load above 0.5 does not).

## 9. Debug artifacts leave the VM before the session does

- A cloud task archives what it wrote to ignored paths (traces, logs, screenshots, test reports) before it ends or wraps up: into the private store (`node {{JSTACK_TOOLS}}/cloud/cloud-kit.mjs put <branch>/artifacts/<run>/<name> <file>`, encrypted), or as a pushed artifact (a CI upload or a dedicated artifacts branch, for what the team must see). The handoff lists every archived key.
  - Why: ignored paths die with the VM. A failed run that left its trace in an ignored folder cannot be read the next morning, so the failure gets guessed at instead of read.
  - Check: before `handoff --state failed|wrapped|ready`, `git status --ignored --porcelain <debug dirs>` lists nothing that is missing from the handoff's archived keys; a `failed` handoff with no `artifacts/` key is refused. **Unverified:** jstack does not enforce this in `cloud-kit.mjs` yet; the check is manual until it does.

## 10. Orphan commits

**Rule:** a session, a worktree or a train never ends while its commits live only on a branch nothing ships. Before a
session is marked done, before a session or train branch is deleted and before a worktree is removed, every commit is
on a kept branch: the work branch, another non-session branch, the integration branch (same commit, same patch or same
content after a squash) or a merged pull request head.

**Why and the failures that taught it** (one night's audit across four repos):
- A cloud session pushes to its own `claude/<slug>-<6 chars>` branch while the kit expects the work branch. An
  experiment's 27 result commits and a fix session's 7 commits sat only there; the work branch stayed at its start. The
  registry never learned the session branch (the session published no status with it), so nothing looked.
- `done --cleanup` deleted the recorded session branch without asking whether its commits were anywhere else.
- A resumed session duplicated an earlier one's commits under new hashes: the same work twice, one copy orphaned.
- `worktree remove --force` drops uncommitted edits and the commits of a detached HEAD without a word.
- A train branch is force-pushed on every run: a fix-up commit made on the train itself, not on a work branch, is gone
  at the next run.

**Checks:**
- `node tools/cloud/orphans.mjs [--rescue] [--trains]` lists every session branch on origin (`JSTACK_SESSION_BRANCH_PREFIX`,
  default `claude/`; `--trains` adds `train/*`) as `safe` or `ORPHAN`, and exits 1 while any orphan is left. The work
  branch is found by name (`<prefix><slug>-<6 chars>` belongs to `*/<slug>`), else as the one non-session branch the
  session descends from. `--rescue` fast-forwards the work branch to the session branch and never forces; a work branch
  that moved on its own is listed as `diverged` for a person to merge or to open as a draft PR for review. A rescue is
  never labelled ready for the train: someone reviews it first.
- A kit's `done` refuses while the session's branch holds orphans, unless the caller states why they can go (and then
  keeps the branch, so the commits stay reachable).
- `tools/worktree-deps.mjs remove` refuses a worktree with uncommitted tracked edits, a detached HEAD whose commits no
  ref keeps, or `--delete-branch` on commits only that branch holds; `--discard-work` overrides.
- Before deleting any branch, the branch guard still applies: an agent deletes only branches it created.

**Unverified:** squash merges are recognised by content only while the integration branch has not changed the same
lines since; past that the check needs the merged PR head (gh), and without gh it reports an orphan for a person to
look at, which is the safe side.

The 32 GB laptop would like it noted that none of its sessions ever got resumed twice. It also never left the house.
