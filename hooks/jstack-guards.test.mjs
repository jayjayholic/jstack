// node --test hooks/jstack-guards.test.mjs
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { pre, cleanup, norm } from './jstack-guards.mjs'

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
  fs.writeFileSync(cfgFile, JSON.stringify({ log: logFile, projects: [{ name: 'test', roots: [repo], heavyLock: { lockScript: '/x/heavy-lock.sh' } }] }))
  process.env.JSTACK_GUARDS_CONFIG = cfgFile
  process.env.CLAUDE_PLUGIN_DATA = path.join(tmp, 'data')
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
    assert.equal(call(c, { cwd }), null, `${c} @ ${cwd}`)
  }
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
  assert.deepEqual(cleanup({ session_id: 's1', agent_id: 'x', cwd: wt, hook_event_name: 'SubagentStop' }, env), { killed: [] })
  process.env.JSTACK_GUARDS_CONFIG = save
})

test('no config match: another project is untouched', () => {
  assert.equal(pre({ session_id: 's1', agent_id: 'o', cwd: os.homedir(), tool_name: 'Bash', tool_input: { command: 'tsc' } }, {}), null)
})

test('cleanup: kills a server the agent started in its worktree, spares older and main-checkout processes', async () => {
  const older = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', '--', wt], { stdio: 'ignore' })
  await new Promise(r => setTimeout(r, 3000))
  call(`cd ${wt.replace(/\\/g, '/')} && bun run start`, { agent: 'C1' })
  const mine = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', '--', wt], { stdio: 'ignore' })
  const main = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', '--', repo], { stdio: 'ignore' })
  await new Promise(r => setTimeout(r, 1500))
  const out = cleanup({ session_id: 's1', agent_id: 'C1', cwd: repo, hook_event_name: 'SubagentStop' }, env)
  await new Promise(r => setTimeout(r, 1000))
  const alive = p => { try { process.kill(p.pid, 0); return true } catch { return false } }
  try {
    assert.ok(out.killed.includes(mine.pid), 'own server killed')
    assert.equal(alive(mine), false)
    assert.equal(alive(older), true, 'process older than the agent spared')
    assert.equal(alive(main), true, 'main checkout process spared')
  } finally { older.kill(); main.kill(); mine.kill() }
})

test('cleanup: Stop is a no-op unless onStop is set', () => {
  call(`cd ${wt.replace(/\\/g, '/')} && ls`, { agent: undefined })
  assert.deepEqual(cleanup({ session_id: 's1', cwd: wt, hook_event_name: 'Stop' }, env), { killed: [] })
})

test('norm: MSYS, Windows and forward-slash paths compare equal', () => {
  if (process.platform !== 'win32') return
  assert.equal(norm('/c/dev/x/'), norm('C:\\dev\\x'))
})
