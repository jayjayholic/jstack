import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildParents } from './lib.mjs'
import { decideKills, trackActivity, decideHung, decideRamClean, decideDockerStop, shouldTrigger, topTriggers, runWarden, wardenConfig } from './warden.mjs'
import { computeFloor } from './ops.mjs'

const NOW = Date.parse('2026-10-25T20:00:00Z')
const WT = 'C:\\dev\\app\\.worktrees\\feat-a'
const cfg = wardenConfig({})

// A process row the way the collector hands it to the warden. ppid 999 has no process: the parent is gone.
function proc(pid, name, extra = {}) {
  return { pid, ppid: 999, create: String(pid), name, kind: name.replace(/\.exe$/, ''), wt: WT, cmd: `${name} --something`, ageMin: 120, cpuNow: 0, priv: 100 * 1048576, ...extra }
}
function decide(procs, opts = {}) {
  const activity = opts.activity ?? new Map(procs.map(p => [`${p.pid}:${p.create}`, { lastBusyAt: NOW - 3 * 3600000 }]))
  return decideKills(procs, buildParents(procs), { now: NOW, cfg: opts.cfg ?? cfg, selfPid: 1, locks: opts.locks ?? [], keepPids: opts.keep ?? new Set(), activity })
}
const pids = ks => ks.map(k => k.pid).sort((a, b) => a - b)

// ---------- orphan detection ----------

test('kills an orphaned grep past the short limit, even while it burns CPU', () => {
  assert.deepEqual(pids(decide([proc(10, 'grep.exe', { cpuNow: 98, ageMin: 70, wt: 'app:grep' })])), [10])
})

test('leaves processes whose parent is alive, and young orphans', () => {
  const parent = { pid: 5, ppid: 0, create: '1', name: 'bash.exe', kind: 'bash', wt: WT, cmd: 'bash', ageMin: 200, cpuNow: 0, priv: 0 }
  const child = proc(11, 'grep.exe', { ppid: 5, create: '2' })
  assert.deepEqual(decide([parent, child]), [], 'parent alive')
  assert.deepEqual(decide([proc(12, 'grep.exe', { ageMin: 9 })]), [], 'younger than 10 min')
  assert.deepEqual(decide([proc(13, 'grep.exe', { ppid: 0 })]), [], 'no parent id at all (system)')
})

test('a parent pid reused by a younger process still counts as gone', () => {
  const impostor = { pid: 5, ppid: 0, create: '900', name: 'cmd.exe', kind: 'cmd', wt: '', cmd: 'cmd', ageMin: 1, cpuNow: 0, priv: 0 }
  assert.deepEqual(pids(decide([impostor, proc(14, 'rg.exe', { ppid: 5, create: '100' })])), [14])
})

test('servers and browsers: only idle ones, only in an agent worktree', () => {
  assert.deepEqual(pids(decide([proc(20, 'node.exe', { cmd: 'node next start -p 3101' })])), [20], 'idle 3 h in a worktree')
  assert.deepEqual(decide([proc(21, 'node.exe', { cpuNow: 5 })]), [], 'busy now')
  assert.deepEqual(decide([proc(22, 'node.exe')], { activity: new Map([['22:22', { lastBusyAt: NOW - 10 * 60000 }]]) }), [], 'busy 10 min ago')
  assert.deepEqual(decide([proc(23, 'node.exe', { wt: 'C:\\dev\\app' })]), [], 'main checkout: the human\'s local app')
  assert.deepEqual(decide([proc(24, 'node.exe', { wt: 'app:node' })]), [], 'outside any project')
  assert.deepEqual(decide([proc(25, 'node.exe', { ageMin: 20 })]), [], 'younger than 30 min')
  assert.deepEqual(pids(decide([proc(26, 'chrome-headless-shell.exe', { kind: 'browser', wt: 'app:x', cmd: 'chrome-headless-shell --remote-debugging-pipe' })])), [26])
  assert.deepEqual(decide([proc(27, 'chrome.exe', { kind: 'chrome', wt: 'app:chrome', cmd: 'chrome.exe' })]), [], 'the human\'s own Chrome')
})

// ---------- protection ----------

test('never kills protected processes', () => {
  const cases = [
    proc(30, 'claude.exe', { kind: 'claude' }),
    proc(31, 'node.exe', { kind: 'mcp', cmd: 'node C:\\x\\mcp-server\\index.js' }),
    proc(32, 'node.exe', { cmd: 'node C:\\Users\\me\\.jstack\\perf\\app\\perf\\collect.mjs' }),
    proc(33, 'node.exe', { cmd: 'node docker-compose-helper.js' }),
    proc(34, 'Discord.exe', { kind: 'discord' }),
    proc(35, 'Code.exe', { kind: 'code' }),
    proc(36, 'grep.exe', { cmd: '' }),
    proc(37, 'node.exe', { cmd: 'node node_modules/typescript/lib/tsserver.js' }),
    proc(1, 'grep.exe'),
  ]
  assert.deepEqual(decide(cases), [])
})

test('never kills the heavy-lock holder\'s worktree or a keep-browser pid', () => {
  const locks = [['.heavy-lock', 'build', 3, WT]]
  assert.deepEqual(decide([proc(40, 'tsc.exe')], { locks }), [])
  assert.deepEqual(decide([proc(41, 'grep.exe', { wt: 'app:grep', cmd: `grep -r x ${WT.replace(/\\/g, '/')}` })], { locks }), [])
  assert.deepEqual(decide([proc(42, 'chrome-headless-shell.exe', { kind: 'browser', cmd: '--headless' })], { keep: new Set([42]) }), [])
})

test('a tree with a protected descendant is left alone; otherwise the whole tree goes, children first', () => {
  const root = proc(50, 'node.exe', { cmd: 'node runner.js' })
  const kid = { ...proc(51, 'claude.exe', { kind: 'claude' }), ppid: 50, create: '60' }
  assert.deepEqual(decide([root, kid]), [])
  const kid2 = { ...proc(52, 'node.exe', { cmd: 'node worker.js' }), ppid: 50, create: '60' }
  const [k] = decide([root, kid2])
  assert.deepEqual(k.tree, [52, 50])
})

test('at most maxKillsPerTick per tick, and the custom protect pattern', () => {
  const many = Array.from({ length: 15 }, (_, i) => proc(100 + i, 'grep.exe'))
  assert.equal(decide(many).length, 10)
  assert.deepEqual(decide([proc(60, 'grep.exe', { cmd: 'grep keepme' })], { cfg: wardenConfig({ warden: { protect: 'keepme' } }) }), [])
})

// ---------- activity, hung tests ----------

test('hung tests are flagged after 15 min at 90%+, once, and never killed', () => {
  const t = proc(70, 'bun.exe', { ppid: 5, kind: 'bun', cmd: 'bun test src/a.test.ts', cpuNow: 98 })
  const activity = new Map()
  trackActivity([t], activity, NOW - 16 * 60000)
  trackActivity([t], activity, NOW)
  const h = decideHung([t], activity, { now: NOW, cfg })
  assert.equal(h.length, 1)
  assert.equal(h[0].minutes, 16)
  assert.deepEqual(decideHung([t], activity, { now: NOW, cfg, noticed: new Set(['70:70']) }), [], 'once')
  trackActivity([{ ...t, cpuNow: 20 }], activity, NOW + 60000)
  assert.deepEqual(decideHung([t], activity, { now: NOW + 60000, cfg }), [], 'dropping below 90% resets it')
  const server = proc(71, 'node.exe', { ppid: 5, cmd: 'node server.js', cpuNow: 99 })
  trackActivity([server], activity, NOW - 30 * 60000); trackActivity([server], activity, NOW)
  assert.deepEqual(decideHung([server], activity, { now: NOW, cfg }), [], 'only tests')
})

// ---------- RAM clean and cooldown ----------

test('RAM clean below 10% available, with a cooldown', () => {
  const m = { totalMb: 32000, availMb: 2000 }
  assert.ok(decideRamClean(m, { now: NOW, cfg, lastRunAt: 0 }))
  assert.equal(decideRamClean(m, { now: NOW, cfg, lastRunAt: NOW - 5 * 60000 }), null, 'cooldown 10 min')
  assert.ok(decideRamClean(m, { now: NOW, cfg, lastRunAt: NOW - 11 * 60000 }))
  assert.equal(decideRamClean({ totalMb: 32000, availMb: 8000 }, { now: NOW, cfg }), null)
  assert.equal(decideRamClean(m, { now: NOW, cfg: wardenConfig({ warden: { ramCleanTask: '' } }) }), null, 'no task configured')
})

test('triggers have a cooldown per type and key', () => {
  const s = {}
  assert.ok(shouldTrigger(s, 'hung', 'a', NOW, 30))
  assert.ok(!shouldTrigger(s, 'hung', 'a', NOW + 60000, 30))
  assert.ok(shouldTrigger(s, 'hung', 'b', NOW + 60000, 30))
  assert.ok(shouldTrigger(s, 'hung', 'a', NOW + 31 * 60000, 30))
})

test('new top consumers: the first 15 ticks only learn', () => {
  const s = {}
  const rec = g => ({ g })
  for (let i = 0; i < 15; i++) assert.deepEqual(topTriggers(rec([['node.exe', '', '', 100, 1000]]), s, NOW), [])
  const t = topTriggers(rec([['node.exe', '', '', 100, 1000], ['rg.exe', '', '', 900, 50]]), s, NOW)
  assert.deepEqual(t.map(x => x.key), ['rg.exe'])
})

// ---------- docker idle ----------

test('docker stop only after the idle window, and never in the first window after start', () => {
  const d = wardenConfig({ warden: { docker: { project: 'evalstack' } } })
  assert.equal(decideDockerStop({ running: true, lastActiveAt: NOW - 40 * 60000 }, { now: NOW, cfg: d, startedAt: NOW - 10 * 60000 }), null, 'just started watching')
  assert.equal(decideDockerStop({ running: true, lastActiveAt: NOW - 20 * 60000 }, { now: NOW, cfg: d, startedAt: NOW - 60 * 60000 }), null, 'active 20 min ago')
  assert.ok(decideDockerStop({ running: true, lastActiveAt: NOW - 31 * 60000 }, { now: NOW, cfg: d, startedAt: NOW - 60 * 60000 }))
  assert.equal(decideDockerStop({ running: false }, { now: NOW, cfg: d, startedAt: 0 }), null)
  assert.equal(decideDockerStop({ running: true, lastActiveAt: 0 }, { now: NOW, cfg, startedAt: 0 }), null, 'no project configured')
})

// ---------- the runner: modes, memory, fail-safe ----------

function runOnce(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-'))
  const written = []
  const killed = []
  const procs = opts.procs ?? [proc(80, 'grep.exe', { cpuNow: 50 })]
  const io = {
    append: (file, rec) => written.push([path.basename(file), rec]),
    kill: pids => { if (opts.killThrows) throw new Error('boom'); killed.push(...pids); return pids },
    keepMarkers: () => new Set(), run: () => ({ status: 0 }), floor: null,
    dockerObserve: () => ({ running: false }),
  }
  const did = runWarden({ now: NOW, procs, parent: buildParents(procs), record: { m: { availMb: 9000, totalMb: 32000, cpu: 30 }, g: [], lock: [] }, cfg: { warden: opts.warden ?? {} }, state: opts.state ?? {}, dir, io })
  fs.rmSync(dir, { recursive: true, force: true })
  return { did, written, killed }
}

test('act mode kills and logs what, why and the metric before', () => {
  const { did, killed } = runOnce()
  assert.deepEqual(killed, [80])
  const k = did.find(d => d.action === 'kill')
  assert.equal(k.mode, 'act')
  assert.match(k.why, /orphaned grep/)
  assert.equal(k.before.availMb, 9000)
  assert.deepEqual(k.killed, [80])
})

test('the same orphan killed three times in 2 h raises a respawning-orphan trigger', () => {
  const state = {}
  const triggers = () => runOnce({ state, procs: [proc(90 + Object.keys(state.killedCmds ?? {}).length, 'grep.exe', { cmd: 'grep -r loop' })] }).written.filter(([f, r]) => f === 'triggers.jsonl' && r.type === 'respawning-orphan')
  assert.equal(triggers().length, 0)
  assert.equal(triggers().length, 0)
  assert.equal(triggers().length, 1)
})

test('dry mode logs the same decision without killing; off does nothing', () => {
  const dry = runOnce({ warden: { mode: 'dry' } })
  assert.deepEqual(dry.killed, [])
  assert.equal(dry.did.find(d => d.action === 'kill').mode, 'dry')
  const off = runOnce({ warden: { mode: 'off' } })
  assert.deepEqual(off.did, [])
  assert.deepEqual(off.written, [])
})

test('fail-safe: an error in one step is logged and the other steps still run', () => {
  const state = {}
  const { did } = runOnce({ killThrows: true, state, procs: [proc(81, 'grep.exe')] })
  assert.ok(did.some(d => d.action === 'error' && d.step === 'kills'))
  assert.ok(state.machineWindow?.length === 1, 'the trigger step ran after the failed kill step')
})

test('effects: the next tick records available RAM after an action', () => {
  const state = {}
  runOnce({ state })
  assert.equal(state.pendingEffects.length, 1)
  const { did } = runOnce({ state, procs: [] })
  const e = did.find(d => d.action === 'effect')
  assert.equal(e.of, 'kill')
  assert.equal(e.delta.availMb, 0)
})

// ---------- floor ----------

test('floor: p25 of 15-minute windows with agent work running; idle stretches do not count', () => {
  const frame = (cpu, active) => ({ m: { cpu: [cpu, cpu], usedPct: [50, 50] }, g: active ? [['node.exe', 'node', WT, 20, 20, 100, 100, 1]] : [] })
  const frames = [...Array.from({ length: 30 }, (_, i) => frame(20 + i, true)), ...Array.from({ length: 30 }, () => frame(1, false))]
  const f = computeFloor(frames)
  assert.ok(f.windows >= 2)
  assert.ok(f.cpu.p25 >= 20, `idle windows excluded, got ${f.cpu.p25}`)
  assert.equal(computeFloor([]).windows, 0)
})
