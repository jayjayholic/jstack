# Cloud sessions: the rules that keep them honest

Reference for `/train` section 8. Development is local, in local worktrees. A branch is committed and pushed only when it is READY for tests. The cloud then runs the heavy jobs on that READY branch: browser work (Playwright, screenshots, UI checks) and memory-heavy work (build, typecheck, CI, full test suites). Once it is tested there, it merges through the normal local train. No development in the cloud, no cloud train session, no automatic resume. A build that must run locally takes the heavy lock with a capped heap (`NODE_OPTIONS=--max-old-space-size=<MB>`). Every rule below says what to do, why, how it failed when nobody did it, and the command or test that proves it holds. "Unverified" means seen once, or never tested end to end; treat it as a guess until your own run shows it.

Words used below: a **cloud session** is one Claude Code session on a cloud VM, running the heavy checks of one READY branch. Each session pushes to its own **session branch** (`claude/*`). The **registry** is the local file that tracks sessions (branch, session id, account, state). The **integration branch** is `{{INTEGRATION_BRANCH}}`.

## 1. The registry survives concurrent writers

- **Lock, atomic write, merge per id.** Every read-modify-write takes a lock file (`open(path + '.lock', 'wx')`, treated as stale after a fixed age), re-reads the file under the lock, merges the writer's entries into the current ones per id (the newer change wins; a `done` entry stays done unless a newer start replaced it; nobody's entry is dropped), writes a temp file and renames it over the original.
  - Why: several agents and the watcher write the same file. Read, change, write without a lock means the last writer wins with a stale copy.
  - Failure: two writers each read the registry, each added their own session, and the second save erased the first's entry. The lost session was never polled.
  - Check: a test that starts 20 processes, each adding a distinct id at the same moment, and expects 20 entries; plus a test that a stale copy cannot flip a `done` entry back to running.

## 2. A gate counts its results against its input

The `/train` lesson "A parallel gate must count its results against its input list" holds in the cloud too: each child exits 0 or 1 and writes its own result line, children get `</dev/null`, and the gate fails naming every file without a result. Check: the gate prints `<results>/<inputs>` and fails when they differ.

## 3. No raw TCP out of the VM

- The cloud VM reaches the outside through an HTTPS proxy. Plan for HTTPS and WebSocket only. A database, cache or SSH host outside the VM needs its HTTPS or WebSocket API, or a WS bridge you run next to it.
  - Failure: a query to a database outside the VM hung for over two minutes, while the same database answered from the laptop. It looked like an IP allowlist; it was the transport.
  - Check: `node {{JSTACK_TOOLS}}/cloud/tunnel.mjs start <host:port>` prints `CONNECT 200` for the target, or don't use the tunnel for it.
  - **Unverified:** `tunnel.mjs` (CONNECT through the proxy to a non-HTTPS port). It got a 200 once and hung elsewhere. Use the services' own VMs (the session's Postgres and Redis) or HTTPS APIs first.

## 4. What the cloud will not do for you

- **Branch deletions:** the cloud's GitHub proxy refuses them (and tag pushes, and GraphQL; use REST through `gh api`). Clean up `claude/*` branches from the laptop, only the ones your tooling recorded as created by it. Check: after `done`, `git ls-remote origin 'refs/heads/claude/*'` no longer lists that session's branch.
- **Folder trust:** `claude --cloud` starts from a local folder and stops at "Do you trust this folder?" for a folder never trusted, and nobody answers it inside a pseudo-terminal. Trust each repo (and each worktree root not covered by a trusted parent) once, by hand: `cd <folder> && claude`, answer Yes. Never automate the answer. Check: before `start`, read `~/.claude.json` and confirm `projects["<folder>"].hasTrustDialogAccepted` is true for the folder or a parent; stop with that fix if not.
- **A session idle on an approval expires.** A prompt nobody answers holds the session until the VM pauses or is reclaimed, and background processes die with it. Cloud jobs run without prompts they cannot answer.

## 5. Debug artifacts leave the VM before the session does

- A cloud task archives what it wrote to ignored paths (traces, logs, screenshots, test reports) before it ends: into the private store (`node {{JSTACK_TOOLS}}/cloud/cloud-kit.mjs put <branch>/artifacts/<run>/<name> <file>`, encrypted), or as a pushed artifact (a CI upload or a dedicated artifacts branch, for what the team must see). The handoff lists every archived key.
  - Why: ignored paths die with the VM. A failed run that left its trace in an ignored folder cannot be read the next morning, so the failure gets guessed at instead of read.
  - Check: before `handoff --state failed|ready`, `git status --ignored --porcelain <debug dirs>` lists nothing that is missing from the handoff's archived keys; a `failed` handoff with no `artifacts/` key is refused. **Unverified:** jstack does not enforce this in `cloud-kit.mjs` yet; the check is manual until it does.

## 6. Orphan commits

**Rule:** a session, a worktree or a train never ends while its commits live only on a branch nothing ships. Before a
session is marked done, before a session or train branch is deleted and before a worktree is removed, every commit is
on a kept branch: the work branch, another non-session branch, the integration branch (same commit, same patch or same
content after a squash) or a merged pull request head.

**Why and the failures that taught it** (one night's audit across four repos):
- A cloud session pushes to its own `claude/<slug>-<6 chars>` branch while the kit expects the work branch. An
  experiment's 27 result commits and a fix session's 7 commits sat only there; the work branch stayed at its start. The
  registry never learned the session branch (the session published no status with it), so nothing looked.
- `done --cleanup` deleted the recorded session branch without asking whether its commits were anywhere else.
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

The 32 GB laptop would like it noted that development is back home, and the cloud now only gets the heavy lifting.
