// node --test hooks/jstack-guards.test.mjs
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { pre, post, cleanup, norm } from './jstack-guards.mjs'
import * as B from './jstack-browsers.mjs'
import * as calls from './jstack-calls.mjs'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jstack-guards-test-'))
const repo = path.join(tmp, 'repo')
const wt = path.join(repo, '.worktrees', 'feat-a')
const logFile = path.join(tmp, 'guard-log.jsonl')
const cfgFile = path.join(tmp, 'guards.json')
const env = { CLAUDE_PROJECT_DIR: repo }

before(() => {
  fs.mkdirSync(path.join(repo, 'src', 'lib'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'node_modules', 'x'), { recursive: true })
  const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' })
  git('init', '-q')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a')
  git('add', '.'); git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'init')
  git('worktree', 'add', '-q', wt, '-b', 'feat-a')
  fs.mkdirSync(path.join(wt, 'src', 'lib'), { recursive: true })
  fs.writeFileSync(cfgFile, JSON.stringify({ log: logFile, projects: [{ name: 'test', roots: [repo], heavyLock: { lockScript: '/x/heavy-lock.sh' }, browsers: { enabled: true } }] }))
  process.env.JSTACK_GUARDS_CONFIG = cfgFile
  process.env.CLAUDE_PLUGIN_DATA = path.join(tmp, 'data')
  process.env.JSTACK_HOME = path.join(tmp, 'jstack-home')
})

after(() => fs.rmSync(tmp, { recursive: true, force: true }))

let n = 0
const call = (command, extra = {}) => pre({ session_id: 's1', agent_id: extra.agent ?? `a${++n}`, cwd: extra.cwd ?? wt, tool_name: extra.tool ?? 'Bash', tool_input: { command } }, env)
const denied = out => out?.hookSpecificOutput?.permissionDecision === 'deny'

test('worktree removal goes through worktree-deps.mjs, which unlinks junctions first', () => {
  for (const c of ['git worktree remove .worktrees/x', 'git -c core.longpaths=true worktree remove --force /c/r/.worktrees/x', 'robocopy C:/empty C:/r/.worktrees/x /MIR']) {
    const out = call(c)
    assert.ok(denied(out), c)
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /worktree-deps\.mjs remove/)
  }
  for (const c of ['node /x/worktree-deps.mjs remove .worktrees/x', 'git worktree list', 'git worktree add .worktrees/y -b y', 'robocopy a b /E']) assert.ok(!denied(call(c)), c)
})

test('heavy: blocks bare typecheck, build and install', () => {
  for (const c of ['tsc --noEmit', 'bun run typecheck', 'npx tsc -p .', 'cd /c/x && next build --turbopack', 'bun install', 'npm install', 'FOO=1 bunx next build', 'node_modules/.bin/tsc', 'bash -c "bun run build"', 'yarn build', 'node node_modules/typescript7/bin/tsc --noEmit', 'node --max-old-space-size=8192 node_modules/typescript/bin/tsc --noEmit','bun run typecheck:fast 2>&1 | tail -5']) {
    assert.ok(denied(call(c)), c)
  }
})

test('heavy: allows wrapped, light and unrelated commands', () => {
  for (const c of ['source /x/heavy-lock.sh && tc_run "bun run typecheck"', 'heavy_acquire build && heavy_capped "bunx next build"; heavy_release', 'tsc --version', 'git commit -m "run tsc and next build"', 'grep tsc package.json', 'bun run test', 'echo bun install', 'bun add zod']) {
    assert.equal(call(c), null, c)
  }
})

test('heavy: PowerShell tool is checked too, and the reason says how to retry', () => {
  const out = call('Set-Location C:\\x; bun run typecheck', { tool: 'PowerShell' })
  assert.ok(denied(out))
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /tc_run "bun run typecheck"/)
})

test('scan: blocks recursive scans over the repo root, worktrees and node_modules', () => {
  for (const [c, cwd] of [['grep -rn foo .', repo], ['grep -r foo', wt], [`find ${repo.replace(/\\/g, '/')} -name "*.ts"`, wt], ['du -sh .worktrees', repo], ['grep -rn foo node_modules/x', wt], ['find . -name x', path.dirname(repo)], ['grep -r foo .worktrees/*/src', repo], ['Get-ChildItem -Recurse -Filter *.ts', repo], ['ls -R', wt], ['cd .. && grep -r foo .', path.join(wt, 'src')]]) {
    assert.ok(denied(call(c, { cwd, tool: c.startsWith('Get-') ? 'PowerShell' : 'Bash' })), `${c} @ ${cwd}`)
  }
})

test('scan: allows scoped and non-recursive searches', () => {
  for (const [c, cwd] of [['grep -rn foo src/lib', wt], ['find src -name "*.ts"', wt], ['grep foo a.txt', repo], ['git grep foo', repo], ['find . -maxdepth 1 -name x', repo], ['du -sh src', wt], ['rg foo', repo], ['Get-ChildItem src -Recurse', wt]]) {
    assert.ok(!denied(call(c, { cwd })), `${c} @ ${cwd}`)
  }
})

test('scan note: a scoped recursive grep gets one note per agent, never a block', () => {
  const ctx = out => out?.hookSpecificOutput?.additionalContext ?? ''
  const first = call('grep -rn foo src/lib', { agent: 'N1' })
  assert.ok(!denied(first))
  assert.match(ctx(first), /git grep/)
  assert.match(ctx(first), /literal pipe in rg/)
  assert.equal(call('grep -rn bar src/lib', { agent: 'N1' }), null)
  assert.match(ctx(call('cd src && grep -r foo lib', { agent: 'N2' })), /Grep tool/)
  for (const c of ['grep foo a.txt', 'git grep foo', 'rg foo', 'cat a.txt | grep foo']) {
    assert.equal(call(c, { agent: 'N3', cwd: repo }), null, c)
  }
})

test('scan note: off with scans.nudge false', () => {
  const save = process.env.JSTACK_GUARDS_CONFIG
  const f = path.join(tmp, 'guards-nonudge.json')
  fs.writeFileSync(f, JSON.stringify({ log: logFile, projects: [{ name: 'test', roots: [repo], scans: { nudge: false } }] }))
  process.env.JSTACK_GUARDS_CONFIG = f
  try {
    assert.equal(call('grep -rn foo src/lib', { agent: 'N4' }), null)
    assert.ok(denied(call('grep -rn foo .', { agent: 'N4', cwd: repo })))
  } finally { process.env.JSTACK_GUARDS_CONFIG = save }
})

test('log: records blocks, repeats and whether the next call followed the advice', () => {
  fs.rmSync(logFile, { force: true })
  call('bun run typecheck', { agent: 'L1' })
  call('bun run typecheck', { agent: 'L1' })
  call('source /x/heavy-lock.sh && tc_run "bun run typecheck"', { agent: 'L1' })
  call('grep -r foo .', { agent: 'L2', cwd: repo })
  pre({ session_id: 's1', agent_id: 'L2', cwd: repo, tool_name: 'Grep', tool_input: { pattern: 'foo' } }, env)
  const rows = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.deepEqual(rows.map(r => [r.agent, r.type, r.guard, r.followed ?? null, r.repeat ?? null]), [
    ['L1', 'block', 'heavy-lock', null, 1],
    ['L1', 'next', 'heavy-lock', false, null],
    ['L1', 'block', 'heavy-lock', null, 2],
    ['L1', 'next', 'heavy-lock', true, null],
    ['L2', 'block', 'scan', null, 1],
    ['L2', 'next', 'scan', true, null],
  ])
  assert.ok(rows[0].suggestion.includes('tc_run'))
})

test('no config: every hook is a no-op', () => {
  const save = process.env.JSTACK_GUARDS_CONFIG
  process.env.JSTACK_GUARDS_CONFIG = path.join(tmp, 'missing.json')
  assert.equal(call('bun run typecheck'), null)
  assert.equal(call('grep -r foo .', { cwd: repo }), null)
  assert.deepEqual(cleanup({ session_id: 's1', agent_id: 'x', cwd: wt, hook_event_name: 'SubagentStop' }, env).killed, [])
  process.env.JSTACK_GUARDS_CONFIG = save
})

test('no config match: another project is untouched', () => {
  assert.equal(pre({ session_id: 's1', agent_id: 'o', cwd: os.homedir(), tool_name: 'Bash', tool_input: { command: 'tsc' } }, {}), null)
})

test('cleanup: Stop is a no-op unless onStop is set', () => {
  call(`cd ${wt.replace(/\\/g, '/')} && ls`, { agent: undefined })
  assert.deepEqual(cleanup({ session_id: 's1', cwd: wt, hook_event_name: 'Stop' }, env).killed, [])
})

test('norm: MSYS, Windows and forward-slash paths compare equal', () => {
  if (process.platform !== 'win32') return
  assert.equal(norm('/c/dev/x/'), norm('C:\\dev\\x'))
})

// ---------- ownership-based cleanup and browsers ----------

const PW = 'C:/Users/u/AppData/Local/ms-playwright/chromium-1217/chrome-win/chrome.exe'
const pwArgs = dir => `"${PW}" --enable-automation --remote-debugging-pipe --user-data-dir="${dir}" about:blank`
const proc = (p, pp, n, c, t) => ({ p, pp, n, c, t })
const bashOf = cmd => `"C:\\Program Files\\Git\\bin\\bash.exe" -c "source /c/u/.claude/shell-snapshots/snap.sh 2>/dev/null || true && eval '${cmd.replace(/'/g, `'"'"'`)}' < /dev/null && pwd -P >| /tmp/cwd"`
const benv = { ...env, CLAUDE_PID: '10' }
const wtp = () => wt.replace(/\\/g, '/')
const freshCalls = () => fs.rmSync(path.join(process.env.JSTACK_HOME, 'calls'), { recursive: true, force: true })
const call2 = (agent, command, extra = {}) => {
  const payload = { session_id: 'own', agent_id: agent, cwd: wt, tool_name: 'Bash', tool_input: { command, run_in_background: !!extra.bg } }
  pre(payload, benv)
  if (!extra.open) post(payload, benv)
}
const stop = (agent, extra = {}) => ({ session_id: 'own', agent_id: agent, cwd: wt, hook_event_name: agent ? 'SubagentStop' : 'Stop', ...extra })
const fakeDeps = (procs, closed = [], killed = []) => ({
  listProcesses: () => procs, killTree: pids => killed.push(...pids), selfPid: 1,
  closeBrowsers: ts => { const pids = ts.map(t => t.pid); closed.push(...pids); return new Map(pids.map(p => [p, 'graceful'])) },
})

test('cleanup: kills only what the stopping agent\'s own calls started in its worktree', () => {
  freshCalls()
  const now = Date.now()
  const serve = `cd ${wtp()} && bun run start`
  call2('C1', serve, { bg: true })
  const procs = [
    proc(10, 2, 'claude.exe', 'claude', now - 600000),
    proc(20, 10, 'bash.exe', bashOf(serve), now + 50),
    proc(30, 20, 'bun.exe', `bun run start ${wtp()}`, now + 100),
    proc(31, 30, 'node.exe', `node ${wtp()}/node_modules/next/dist/bin/next start`, now + 150),
    proc(40, 2, 'node.exe', `node ${wtp()}/old-server.js`, now - 5000),
    proc(50, 10, 'bash.exe', bashOf(`cd ${repo.replace(/\\/g, '/')} && bun run dev`), now - 9000),
  ]
  const killed = []
  const out = cleanup(stop('C1', { background_tasks: [] }), benv, fakeDeps(procs, [], killed))
  assert.deepEqual(out.killed.sort(), [20, 30, 31])
  assert.deepEqual(killed.sort(), [20, 30, 31], 'older process 40 and the main checkout shell 50 spared')
})

test('regression 18:12/18:19: an agent paused on its own background build is not cleaned up', () => {
  freshCalls()
  const now = Date.now()
  const build = `cd ${wtp()} && source /c/x/heavy-lock.sh && heavy_acquire build && heavy_capped "bun x next build --turbopack"; heavy_release`
  call2('B1', build, { bg: true })
  const procs = [
    proc(10, 2, 'claude.exe', 'claude', now - 600000),
    proc(20, 10, 'bash.exe', bashOf(build), now + 50),
    proc(21, 20, 'powershell.exe', `powershell -File C:\\x\\run-capped.ps1 -LimitGB 12 -Command "bun x next build --turbopack" -WorkingDirectory ${wt}`, now + 100),
    proc(22, 21, 'bun.exe', `bun x next build --turbopack ${wtp()}`, now + 150),
    proc(23, 22, 'node.exe', `node "${wt}\\node_modules\\next\\dist\\bin\\next" build --turbopack`, now + 200),
    proc(24, 2, 'powershell.exe', `powershell -File C:\\x\\ram-clean.ps1 -Reason "after heavy_release" ${wtp()}`, now + 300),
  ]
  const never = { ...fakeDeps(procs), killTree: pids => assert.deepEqual(pids, [], 'nothing killed') }
  const task = { id: 'b1', type: 'local_bash', status: 'running', description: 'build', command: build.slice(0, 60) }
  assert.equal(cleanup(stop('B1', { background_tasks: [task] }), benv, never).skipped, 'background')
  assert.equal(cleanup(stop('B1'), benv, never).skipped, 'background', 'no background_tasks field: its live shell says the same')
  const done = cleanup(stop('B1', { background_tasks: [{ type: 'local_bash', command: 'something else entirely' }] }), benv, fakeDeps(procs.filter(p => p.p === 10 || p.p === 24)))
  assert.deepEqual(done.killed, [], 'after the build, the orphan ram-clean helper is still never killed')
})

test('regression 18:47: an Explore subagent stopping spares its parent\'s shells in the shared worktree', () => {
  freshCalls()
  const now = Date.now()
  const parentCmd = `cd ${wtp()} && bun run db:generate && bun test src`
  call2('P1', parentCmd, { open: true })
  const childCmd = `cd ${wtp()} && git grep -n cache src/lib | head`
  const childServe = `cd ${wtp()} && node scripts/probe-server.mjs`
  call2('E1', childCmd, { open: true })
  call2('E1', childServe, { bg: true })
  const procs = [
    proc(10, 2, 'claude.exe', 'claude', now - 600000),
    proc(20, 10, 'bash.exe', bashOf(parentCmd), now + 20),
    proc(21, 20, 'node.exe', `node "${wt}\\node_modules\\zenstack\\bin\\cli" generate --schema ./schema/root.zmodel`, now + 40),
    proc(30, 10, 'bash.exe', bashOf(childCmd), now + 30),
    proc(40, 10, 'bash.exe', bashOf(childServe), now + 60),
    proc(41, 40, 'node.exe', `node ${wtp()}/scripts/probe-server.mjs`, now + 80),
  ]
  const killed = []
  const out = cleanup(stop('E1', { background_tasks: [] }), benv, fakeDeps(procs, [], killed))
  assert.ok(!killed.includes(20) && !killed.includes(21), 'parent shell and its zenstack generate spared')
  assert.deepEqual(out.killed.sort(), [30, 40, 41], 'only the child\'s own shells and server')
})

test('calls: a shell is owned by the call whose command it carries; no text match or two close calls means nobody', () => {
  const r = (agent, s, cmd) => ({ session: 's', agent, claudePid: 10, windows: [{ s, e: s + 5000, fp: calls.fingerprint(cmd) }] })
  const A = r('A', 1000, 'npm test'), B = r('B', 1100, 'bun run dev')
  assert.equal(calls.ownerOfShell({ n: 'bash.exe', c: bashOf('bun run dev'), t: 1150 }, [A, B], 9000), B)
  assert.equal(calls.ownerOfShell({ n: 'bash.exe', c: bashOf('ls -la'), t: 1150 }, [A, B], 9000), null)
  assert.equal(calls.ownerOfShell({ n: 'powershell.exe', c: 'powershell -Command $x', t: 1150 }, [A, B], 9000), null, 'no text, starts 100 ms apart')
  assert.equal(calls.ownerOfShell({ n: 'powershell.exe', c: 'powershell -Command $x', t: 1050 }, [A, r('B', 4000, 'x')], 9000), A)
})

test('browsers: only automation browsers count, never the owner Chrome or a default profile', () => {
  const yes = [
    proc(1, 0, 'chrome.exe', pwArgs('C:\\Users\\u\\AppData\\Local\\Temp\\playwright_chromiumdev_profile-abc'), 1),
    proc(2, 0, 'chrome.exe', '"chrome.exe" --remote-debugging-pipe --user-data-dir=C:/Users/u/.playwright-mcp-profile', 1),
    proc(3, 0, 'headless_shell.exe', '"headless_shell.exe" --headless --enable-automation --remote-debugging-pipe --user-data-dir=C:\\t\\x', 1),
  ]
  const no = [
    proc(4, 0, 'chrome.exe', '"C:/Program Files/Google/Chrome/Application/chrome.exe" --profile-directory=Default', 1),
    proc(5, 0, 'chrome.exe', '"chrome.exe" --enable-automation --remote-debugging-port=9222 --user-data-dir="C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\User Data"', 1),
    proc(6, 0, 'chrome.exe', `${pwArgs('C:/t/playwright_x')} --type=renderer`, 1),
    proc(7, 0, 'chrome.exe', '"chrome.exe" --remote-debugging-port=9222 --user-data-dir=C:/work/plain', 1),
    proc(8, 0, 'node.exe', pwArgs('C:/t/playwright_x'), 1),
  ]
  for (const p of yes) assert.ok(B.isAutomationBrowser(p), p.c)
  for (const p of no) assert.ok(!B.isAutomationBrowser(p), p.c)
  assert.ok(B.isAutomationBrowser(no[3], ['C:\\work\\plain']), 'configured extra profile')
})

function browserSession(now, cmd) {
  return [
    proc(10, 2, 'claude.exe', 'claude', now - 600000),
    proc(20, 10, 'bash.exe', bashOf(cmd), now + 50),
    proc(30, 20, 'node.exe', 'node shot.mjs', now + 100),
    proc(40, 30, 'chrome.exe', pwArgs('C:/t/playwright_chromiumdev_profile-1'), now + 300),
    proc(41, 40, 'chrome.exe', `${pwArgs('C:/t/playwright_chromiumdev_profile-1')} --type=renderer`, now + 400),
    proc(50, 2, 'chrome.exe', '"C:/Program Files/Google/Chrome/Application/chrome.exe"', now - 900000),
  ]
}

test('browsers: SubagentStop closes the browser its agent opened, spares the owner Chrome and other agents', () => {
  freshCalls()
  const now = Date.now()
  call2('mine', 'node shot.mjs')
  const closed = []
  const deps = fakeDeps(browserSession(now, 'node shot.mjs'), closed)
  call2('other', 'echo hi')
  assert.deepEqual(cleanup(stop('other', { background_tasks: [] }), benv, deps).browsers.closed, [], 'not the other agent\'s')
  const out = cleanup(stop('mine', { background_tasks: [] }), benv, deps)
  assert.deepEqual(out.browsers.closed, [40])
  assert.deepEqual(closed, [40], 'owner Chrome 50 and renderer 41 never passed to close')
  const rows = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.type === 'browser-close')
  assert.equal(rows.at(-1).pid, 40)
})

test('browsers: a keep marker on the launcher keeps the browser open, and expires after an hour', () => {
  freshCalls()
  const now = Date.now()
  call2('k', 'node map.mjs')
  const deps = fakeDeps(browserSession(now, 'node map.mjs'))
  B.writeKeep([30], 'owner asked for the map')
  assert.deepEqual(cleanup(stop('k', { background_tasks: [] }), benv, deps).browsers, { closed: [], kept: [40] })
  const marker = path.join(process.env.JSTACK_HOME, 'keep-browser', '30')
  const old = (now - 61 * 60000) / 1000
  fs.utimesSync(marker, old, old)
  assert.equal(B.keptPids(undefined, now).has(30), false)
  assert.equal(fs.existsSync(marker), false, 'expired marker deleted')
  call2('k', 'node map.mjs')
  assert.deepEqual(cleanup(stop('k', { background_tasks: [] }), benv, deps).browsers.closed, [40])
})

test('browsers: Stop can be switched off per project, and no browsers key means off', () => {
  freshCalls()
  const save = fs.readFileSync(cfgFile, 'utf8')
  const cfg = JSON.parse(save)
  const never = { ...fakeDeps(browserSession(Date.now(), 'node x.mjs')), closeBrowsers: () => assert.fail('must not close') }
  try {
    cfg.projects[0].browsers.onStop = false
    fs.writeFileSync(cfgFile, JSON.stringify(cfg))
    call2(undefined, 'node x.mjs')
    assert.deepEqual(cleanup(stop(undefined, { background_tasks: [] }), benv, never).browsers.closed, [])
    delete cfg.projects[0].browsers
    fs.writeFileSync(cfgFile, JSON.stringify(cfg))
    call2('z', 'node x.mjs')
    assert.deepEqual(cleanup(stop('z', { background_tasks: [] }), benv, never).browsers.closed, [])
  } finally { fs.writeFileSync(cfgFile, save) }
})

test('browsers: watcher closes orphans and stopped agents only after the grace, never a running agent', () => {
  const t0 = 1_000_000
  const running = { session: 's', agent: 'run', claudePid: 10, windows: [{ s: t0, e: t0 + 1000, fp: calls.fingerprint('node a.mjs') }] }
  const stopped = { session: 's', agent: 'gone', claudePid: 10, windows: [{ s: t0 + 5000, e: t0 + 6000, fp: calls.fingerprint('node b.mjs') }], stoppedAt: t0 + 7000 }
  const procs = [
    proc(10, 1, 'claude.exe', 'claude', t0 - 600000),
    proc(20, 10, 'bash.exe', bashOf('node a.mjs'), t0 + 50), proc(40, 20, 'chrome.exe', pwArgs('C:/t/playwright_a'), t0 + 300),
    proc(21, 10, 'bash.exe', bashOf('node b.mjs'), t0 + 5050), proc(42, 21, 'chrome.exe', pwArgs('C:/t/playwright_b'), t0 + 5300),
    proc(70, 66, 'chrome.exe', pwArgs('C:/t/playwright_o'), t0 - 1000),
  ]
  const seen = {}
  const at = now => B.sweep({ procs, records: [running, stopped], kept: new Set(), seen, now, graceMs: 600000 })
  const first = at(t0 + 10000)
  assert.deepEqual(first.due, [])
  assert.deepEqual(first.waiting.map(b => b.pid).sort(), [42, 70])
  const later = at(t0 + 10000 + 600000)
  assert.deepEqual(later.due.map(b => [b.pid, b.why]).sort(), [[42, 'agent-stopped'], [70, 'orphan']])
  const keptRes = B.sweep({ procs, records: [running, stopped], kept: new Set([70]), seen: {}, now: t0 + 9e9, graceMs: 0 })
  assert.deepEqual(keptRes.due.map(b => b.pid), [42], 'kept orphan stays, running agent 40 stays')
})

test('run-hook: a crash in the guards exits 0 silently and logs a hook-crash line', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'crash-'))
  fs.copyFileSync(new URL('./run-hook.mjs', import.meta.url), path.join(dir, 'run-hook.mjs'))
  fs.writeFileSync(path.join(dir, 'jstack-guards.mjs'), 'export const x = /broken\n')
  const r = spawnSync(process.execPath, [path.join(dir, 'run-hook.mjs'), 'cleanup'], { input: '{}', encoding: 'utf8', env: { ...process.env, JSTACK_GUARDS_CONFIG: cfgFile } })
  assert.equal(r.status, 0)
  assert.equal(r.stdout + r.stderr, '')
  const last = JSON.parse(fs.readFileSync(logFile, 'utf8').trim().split('\n').at(-1))
  assert.equal(last.type, 'hook-crash')
  assert.match(last.error, /SyntaxError/)
})
