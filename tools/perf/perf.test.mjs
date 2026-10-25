import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  parseSnap, parsePs, psTimeTo100ns, cpuPct, machineCpuPct, kindOf, worktreeOf, repoRootOf, buildParents, attribute,
  redactCmd, buildTick, tickToFrame, rollup, expired, top, spikes, patterns,
} from './lib.mjs'
import { verdict, median, parseTime, taskXml } from './perf.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FT = ms => String(BigInt(ms + 11644473600000) * 10000n)

// ---------- parser ----------

test('parseSnap reads machine, process, detail and self lines', () => {
  const text = [
    'M\t100\t300\t200\t34359738368\t17179869184\t20000000000\t60000000000\t1073741824\t1\t2\t3\t4\t2\t1\t5\t10\t7\t8\t400\t20',
    'P\t42\t7\t133000000000000000\tnode.exe\t50000000\t104857600\t52428800\t10\t20\t9\t100',
    'D\t42\t133000000000000000\tC:\\dev\\app\\\tnode  server.js --port 3000',
    'S\t468750\t17072128\t17125376',
    '',
  ].join('\r\n')
  const s = parseSnap(text)
  assert.equal(s.machine.cores, 20)
  assert.equal(s.machine.totalPhys, 34359738368)
  assert.equal(s.machine.diskQueue, 2)
  assert.deepEqual(s.procs[0], { pid: 42, ppid: 7, create: '133000000000000000', name: 'node.exe', cpu: 50000000, priv: 104857600, ws: 52428800, rd: 10, wr: 20, threads: 9, handles: 100 })
  assert.equal(s.details.get('42:133000000000000000').cwd, 'C:\\dev\\app\\')
  assert.equal(s.self.cpu100ns, 468750)
})

test('parseSnap ignores junk and empty input', () => {
  assert.deepEqual(parseSnap('').procs, [])
  const s = parseSnap('garbage\nX\t1\t2\n')
  assert.equal(s.machine, null)
  assert.equal(s.procs.length, 0)
})

test('parsePs and ps TIME formats (posix path)', () => {
  assert.equal(psTimeTo100ns('0:01.50'), 1.5e7)
  assert.equal(psTimeTo100ns('1:02:03'), 3723e7)
  assert.equal(psTimeTo100ns('2-00:00:01'), (2 * 86400 + 1) * 1e7)
  const procs = parsePs('  101     1  2048   0:03.00 /usr/bin/grep\nnot a row\n  7 1 10 0:00.00 /sbin/launchd')
  assert.equal(procs.length, 2)
  assert.equal(procs[0].name, 'grep')
  assert.equal(procs[0].priv, 2048 * 1024)
})

// ---------- CPU delta math ----------

test('cpuPct: 100 = one core over the interval', () => {
  assert.equal(cpuPct(0, 60e7, 60), 100)
  assert.equal(cpuPct(10e7, 40e7, 60), 50)
  assert.equal(cpuPct(0, 4 * 60e7, 60, { cores: 8 }), 400)
})

test('cpuPct: new process counts its lifetime only when it started after the previous tick', () => {
  assert.equal(cpuPct(undefined, 30e7, 60, { createdAfterPrev: true }), 50)
  assert.equal(cpuPct(undefined, 30e7, 60, { createdAfterPrev: false }), 0)
})

test('cpuPct: counter going backwards, zero interval and impossible values give 0', () => {
  assert.equal(cpuPct(50e7, 10e7, 60), 0)
  assert.equal(cpuPct(0, 10e7, 0), 0)
  assert.equal(cpuPct(0, 100 * 60e7, 60, { cores: 4 }), 0)
})

test('machineCpuPct uses kernel time that includes idle', () => {
  assert.equal(machineCpuPct({ idle: 0, kernel: 0, user: 0 }, { idle: 75, kernel: 100, user: 0 }), 25)
  assert.equal(machineCpuPct({ idle: 0, kernel: 0, user: 0 }, { idle: 50, kernel: 50, user: 50 }), 50)
  assert.equal(machineCpuPct({ idle: 5, kernel: 5, user: 5 }, { idle: 5, kernel: 5, user: 5 }), 0)
})

// ---------- attribution ----------

test('kindOf matches mem-map Get-Kind on the common cases', () => {
  assert.equal(kindOf('claude.exe', ''), 'claude')
  assert.equal(kindOf('node.exe', 'node C:\\x\\node_modules\\typescript\\lib\\tsc.js --noEmit'), 'tsc')
  assert.equal(kindOf('node.exe', 'node node_modules/next/dist/bin/next build'), 'next-build')
  assert.equal(kindOf('node.exe', 'node next start -p 3001'), 'next-server')
  assert.equal(kindOf('chrome-headless-shell.exe', 'chrome-headless-shell --remote-debugging-pipe'), 'browser')
  assert.equal(kindOf('bash.exe', 'bash -c "while true; do sleep 5; done"'), 'bash-loop')
  assert.equal(kindOf('tail.exe', 'tail -f log'), 'tail-f')
  assert.equal(kindOf('rg.exe', 'rg foo'), 'grep')
  assert.equal(kindOf('Code.exe', ''), 'code')
})

test('worktreeOf: worktree folder, project node_modules, never a global install', () => {
  assert.equal(worktreeOf('C:/dev/app/.worktrees/feat-x/src'), 'C:\\dev\\app\\.worktrees\\feat-x')
  assert.equal(worktreeOf('node C:\\dev\\app\\node_modules\\vitest\\cli.js'), 'C:\\dev\\app')
  assert.equal(worktreeOf('C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\bun\\bin\\bun.exe run x.ts'), '')
  assert.equal(worktreeOf('"C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js"'), '')
  assert.equal(worktreeOf('/home/me/app/.worktrees/fix-y/node_modules/.bin/tsc'), '/home/me/app/.worktrees/fix-y')
  assert.equal(worktreeOf(''), '')
})

test('attribute: cwd first, then repo root, then command line, then the nearest ancestor; else the app root', () => {
  const create = '133000000000000000'
  const procs = [
    { pid: 1, ppid: 0, create, name: 'explorer.exe' },
    { pid: 2, ppid: 1, create, name: 'claude.exe' },
    { pid: 3, ppid: 2, create, name: 'bash.exe' },
    { pid: 4, ppid: 3, create, name: 'node.exe' },
    { pid: 5, ppid: 1, create, name: 'chrome.exe' },
    { pid: 6, ppid: 5, create, name: 'chrome.exe' },
    { pid: 7, ppid: 1, create, name: 'Code.exe' },
  ]
  const details = new Map([
    [`2:${create}`, { cwd: 'C:\\dev\\app\\', cmd: 'claude' }],
    [`3:${create}`, { cwd: 'C:\\dev\\app\\.worktrees\\feat-a\\', cmd: 'bash -c x' }],
    [`4:${create}`, { cwd: 'C:\\Users\\me\\', cmd: 'node script.js' }],
    [`7:${create}`, { cwd: 'C:\\Users\\me\\', cmd: 'code C:\\dev\\app\\node_modules\\x\\y.js' }],
  ])
  const repoRoot = d => (d.startsWith('C:\\dev\\app') ? 'C:\\dev\\app' : '')
  attribute(procs, details, buildParents(procs), { repoRoot })
  const wt = Object.fromEntries(procs.map(p => [p.pid, p.wt]))
  assert.equal(wt[2], 'C:\\dev\\app')
  assert.equal(wt[3], 'C:\\dev\\app\\.worktrees\\feat-a')
  assert.equal(wt[4], 'C:\\dev\\app\\.worktrees\\feat-a', 'inherits its parent bash')
  assert.equal(wt[6], 'app:chrome', 'no worktree anywhere: the top ancestor below explorer')
  assert.equal(wt[7], 'C:\\dev\\app', 'command line')
})

test('buildParents ignores a parent pid reused by a younger process', () => {
  const procs = [
    { pid: 10, ppid: 0, create: '200', name: 'cmd.exe' },
    { pid: 11, ppid: 10, create: '100', name: 'node.exe' },
  ]
  assert.equal(buildParents(procs).has(11), false)
})

test('repoRootOf walks up to .git and caches; system folders are skipped', () => {
  const calls = []
  const exists = p => { calls.push(p); return p === path.join('/r/proj', '.git') }
  assert.equal(repoRootOf('/r/proj/src/deep', exists), '/r/proj')
  const n = calls.length
  assert.equal(repoRootOf('/r/proj/src/deep', exists), '/r/proj')
  assert.equal(calls.length, n, 'cached')
  assert.equal(repoRootOf('C:\\Windows\\System32', exists), '')
})

test('parity with mem-map.ps1 (Get-Kind and Get-WorktreeOf)', { skip: process.platform !== 'win32' }, () => {
  const cases = [
    { name: 'node.exe', cmd: 'node C:\\dev\\x\\.worktrees\\foo\\node_modules\\typescript\\lib\\tsc.js --noEmit', cwd: '' },
    { name: 'node.exe', cmd: 'node node_modules/next/dist/bin/next build', cwd: 'C:\\dev\\x\\.worktrees\\bar\\' },
    { name: 'bun.exe', cmd: 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\bun\\bin\\bun.exe run bench.ts', cwd: 'C:\\Users\\me\\' },
    { name: 'node.exe', cmd: 'node C:\\dev\\x\\node_modules\\vitest\\vitest.mjs', cwd: '' },
    { name: 'chrome-headless-shell.exe', cmd: 'chrome-headless-shell --remote-debugging-pipe', cwd: '' },
    { name: 'grep.exe', cmd: 'grep -r foo .', cwd: 'C:/dev/x/.Worktrees/baz' },
    { name: 'bash.exe', cmd: 'bash -c "until done; do sleep 1; done"', cwd: '' },
    { name: 'claude.exe', cmd: 'claude', cwd: 'C:\\dev\\x' },
    { name: 'node.exe', cmd: 'node C:\\x\\@modelcontextprotocol\\server.js', cwd: '' },
  ]
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-parity-'))
  const file = path.join(dir, 'cases.json')
  fs.writeFileSync(file, JSON.stringify(cases))
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, '..', 'mem-map.ps1'), '-Classify', file], { encoding: 'utf8' })
  fs.rmSync(dir, { recursive: true, force: true })
  const ps = JSON.parse(r.stdout.trim())
  cases.forEach((c, i) => {
    assert.equal(kindOf(c.name, c.cmd), ps[i].kind, `kind of ${c.cmd}`)
    assert.equal(worktreeOf(c.cwd) || worktreeOf(c.cmd), ps[i].worktree, `worktree of ${c.cwd || c.cmd}`)
  })
})

// ---------- redaction ----------

test('redactCmd strips tokens in every shape a command line carries them', () => {
  const cases = [
    ['node cli.js --token=abcd1234efgh5678', 'abcd1234efgh5678'],
    ['node cli.js --api-key sk_live_0123456789abcdefABCD', 'sk_live_0123456789abcdefABCD'],
    ['gh --auth-token "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"', 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    ['env OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456 node x', 'sk-proj-abcdefghijklmnopqrstuvwxyz123456'],
    ['curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlc2ln" https://x', 'eyJhbGciOiJIUzI1NiJ9'],
    ['curl -H "Authorization: Bearer qwertyuiop12345678" https://x', 'qwertyuiop12345678'],
    ['psql postgres://admin:hunter2pass@db.example.com:5432/app', 'hunter2pass'],
    ['curl https://api.example.com/x?access_token=zzz111yyy222&page=2', 'zzz111yyy222'],
    ['node x.js DB_PASSWORD=correct-horse', 'correct-horse'],
    ['tool --session 9f8e7d6c5b4a', '9f8e7d6c5b4a'],
    ['node x.js Q2hhbmdlTWVQbGVhc2VUaGlzSXNBU2VjcmV0VG9rZW4xMjM0', 'Q2hhbmdlTWVQbGVhc2VUaGlzSXNBU2VjcmV0VG9rZW4xMjM0'],
  ]
  for (const [cmd, secret] of cases) {
    const out = redactCmd(cmd)
    assert.ok(!out.includes(secret), `leaked from: ${cmd} -> ${out}`)
    assert.ok(out.includes('[REDACTED'), `no marker: ${out}`)
  }
})

test('redactCmd keeps ordinary command lines readable', () => {
  const keep = [
    'node C:\\dev\\app\\.worktrees\\feat-x\\node_modules\\typescript\\lib\\tsc.js --noEmit -p tsconfig.json',
    'chrome-headless-shell.exe --type=renderer --lang=en-US --max-old-space-size=4096',
    'git -C C:/dev/app status --porcelain',
    'bun test src/lib/task-sheets/mcp-sign-in-service.test.ts',
    'powershell -Command "$s = $env:CLAUDE_CODE_SHELL_LAUNCHER_SCRIPT; Invoke-Expression $s"',
    'node x.js --name=really_long_but_plain_identifier_words_here',
  ]
  for (const cmd of keep) assert.equal(redactCmd(cmd), cmd.replace(/\s+/g, ' '))
})

test('redactCmd cuts long lines and survives empty input', () => {
  assert.equal(redactCmd(''), '')
  assert.equal(redactCmd(null), '')
  const out = redactCmd(`node ${'a/'.repeat(400)}`, 50)
  assert.ok(out.length <= 53 && out.endsWith('...'))
})

// ---------- ticks and frames ----------

function machine(over = {}) {
  return { idle: 0, kernel: 0, user: 0, totalPhys: 32 * 2 ** 30, availPhys: 16 * 2 ** 30, commit: 0, commitLimit: 0, cache: 0, paged: 0, nonpaged: 0, pfTotal: 0, pfUsed: 0, diskQueue: 0, disks: 1, diskIdle: 0, diskQuery: 0, diskRead: 0, diskWrite: 0, procCount: 3, cores: 4, ...over }
}

test('buildTick: per-group CPU %, memory, short-lived CPU, notable processes, redacted commands', () => {
  const t0 = Date.parse('2026-10-25T12:00:00Z')
  const old = FT(t0 - 3600000)
  const p = (pid, name, cpu, mb, extra = {}) => ({ pid, ppid: 0, create: old, name, cpu, priv: mb * 1048576, ws: mb * 1048576, rd: 0, wr: 0, kind: kindOf(name, extra.cmd ?? ''), wt: extra.wt ?? `app:${name}`, cmd: extra.cmd ?? '' })
  const first = buildTick(null, null, { at: t0, procs: [p(1, 'node.exe', 0, 600), p(2, 'grep.exe', 0, 5)], machine: machine() })
  assert.equal(first.record.dt, 0)
  const procs2 = [
    p(1, 'node.exe', 60e7, 600, { cmd: 'node x --token=supersecret123', wt: 'C:\\dev\\a' }),
    p(2, 'grep.exe', 0, 5),
    { ...p(3, 'tsc.exe', 30e7, 100), create: FT(t0 + 30000) },
  ]
  const { record } = buildTick(first.state, null, { at: t0 + 60000, procs: procs2, machine: machine({ idle: 2 * 60e7, kernel: 2 * 60e7, user: 2 * 60e7 }) })
  assert.equal(record.dt, 60)
  assert.equal(record.m.cpu, 50)
  const g = Object.fromEntries(record.g.map(r => [r[0], r]))
  assert.equal(g['node.exe'][3], 100)
  assert.equal(g['node.exe'][4], 600)
  assert.equal(g['tsc.exe'][3], 50, 'started mid-interval: lifetime CPU counts')
  assert.equal(g['tsc.exe'][8], 1, 'born this tick')
  assert.equal(g._small[6], 1, 'small groups folded together')
  assert.equal(record.m.unacc, 50, '4 cores at 50% = 200, processes explain 150')
  assert.equal(record.p[0][0], 1)
  assert.ok(!JSON.stringify(record).includes('supersecret123'))
})

test('tickToFrame and rollup: time-weighted means, absent counts as zero, max kept', () => {
  const base = Date.parse('2026-10-25T12:00:00Z')
  const rec = (i, cpu) => ({ t: new Date(base + i * 60000).toISOString(), dt: 60, m: { cpu: cpu, usedPct: 50, totalMb: 1, cores: 4 }, g: cpu ? [['node.exe', 'node', 'wt1', cpu, 100, 100, 1, 0, 0]] : [], lock: i < 2 ? [['.heavy-lock', 'build', 3, 'wt1']] : [] })
  const frames = [rec(0, 100), rec(1, 0), rec(2, 50), rec(3, 0), rec(4, 0)].map(tickToFrame)
  const [b] = rollup(frames, 300)
  assert.equal(b.res, 300)
  assert.equal(b.k, 5)
  const node = b.g.find(r => r[0] === 'node.exe')
  assert.equal(node[3], 30)
  assert.equal(node[4], 100)
  assert.deepEqual(b.m.cpu, [30, 100])
  assert.equal(b.lock[0][3], 2, 'two minutes held')
  assert.equal(rollup(rollup(frames, 300), 3600)[0].g[0][3], 30, 'rollups roll up again')
})

test('top, spikes and patterns over frames', () => {
  const base = Date.parse('2026-10-25T12:00:00Z')
  const fr = (i, cpu, g) => tickToFrame({ t: new Date(base + i * 60000).toISOString(), dt: 60, m: { cpu, usedPct: 50, unacc: 0 }, g })
  const frames = [
    fr(0, 20, [['node.exe', 'tsc', 'w1', 100, 4000, 4000, 1, 0, 0]]),
    fr(1, 95, [['node.exe', 'tsc', 'w1', 300, 6000, 6000, 2, 0, 0], ['grep.exe', 'grep', 'app:claude', 50, 80, 80, 9, 0, 0]]),
    fr(2, 96, [['grep.exe', 'grep', 'app:claude', 10, 80, 80, 6, 0, 0]]),
  ]
  const rows = top(frames, { by: 'name' })
  const node = rows.find(r => r.key === 'node.exe')
  assert.equal(node.cpuMean, 133.3)
  assert.equal(node.cpuMax, 300)
  assert.equal(node.memMaxMb, 6000)
  const sp = spikes(frames, { cpu: 90 })
  assert.equal(sp.length, 1)
  assert.equal(sp[0].minutes, 2)
  const pats = patterns(frames).map(p => p.pattern)
  assert.ok(pats.includes('grep-storm'))
  assert.ok(pats.includes('duplicate-typecheck'))
  assert.deepEqual(top([], {}), [])
  const busy = n => Array.from({ length: n }, (_, i) => ({ ...fr(i, 50, []), p: [[77, 'bun.exe', 'tests', 'w1', 98, 300, 5, 'bun test x.test.ts']] }))
  assert.ok(patterns(busy(10)).some(p => p.pattern === 'stuck-busy-process' && /pid 77/.test(p.evidence)))
  assert.ok(!patterns(busy(9)).some(p => p.pattern === 'stuck-busy-process'))
})

// ---------- retention ----------

test('expired: raw after 14 days, 5-minute rollups after 90, hourly after 400, nothing else', () => {
  const now = Date.parse('2026-10-25T12:00:00')
  const files = ['raw/2026-10-25.jsonl', 'raw/2026-10-12.jsonl.gz', 'raw/2026-10-11.jsonl.gz', '5m/2026-07-28.jsonl.gz', '5m/2026-07-27.jsonl.gz', '1h/2025-09.jsonl', '1h/2025-08.jsonl', 'ledger.jsonl', 'raw/notes.txt']
  assert.deepEqual(expired(files, now), ['raw/2026-10-11.jsonl.gz', '5m/2026-07-27.jsonl.gz', '1h/2025-08.jsonl'])
  assert.deepEqual(expired(files, now, { rawDays: 1, fiveMinDays: 1, hourDays: 10000 }).sort(), ['5m/2026-07-27.jsonl.gz', '5m/2026-07-28.jsonl.gz', 'raw/2026-10-11.jsonl.gz', 'raw/2026-10-12.jsonl.gz'])
  assert.deepEqual(expired([], now), [])
})

test('finalizeDays compresses past days, writes rollups, keeps today, and the reader still sees every tick', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-store-'))
  process.env.JSTACK_PERF_DIR = dir
  const { appendTick, finalizeDays, readFrames } = await import(`./store.mjs?${Date.now()}`)
  const y = new Date(); y.setDate(y.getDate() - 1); y.setHours(10, 0, 0, 0)
  for (let i = 0; i < 10; i++) appendTick({ t: new Date(y.getTime() + i * 60000).toISOString(), dt: 60, m: { cpu: 10, usedPct: 40, totalMb: 1, cores: 4 }, g: [['node.exe', 'node', 'w', 20, 100, 100, 1, 0, 0]] }, dir)
  appendTick({ t: new Date().toISOString(), dt: 60, m: { cpu: 10 }, g: [] }, dir)
  const day = new Date(y).toLocaleDateString('sv-SE')
  const res = finalizeDays(Date.now(), dir)
  assert.deepEqual(res.finalized, [day])
  assert.ok(fs.existsSync(path.join(dir, 'raw', `${day}.jsonl.gz`)))
  assert.ok(!fs.existsSync(path.join(dir, 'raw', `${day}.jsonl`)))
  assert.ok(fs.existsSync(path.join(dir, '5m', `${day}.jsonl.gz`)))
  assert.equal(zlib.gunzipSync(fs.readFileSync(path.join(dir, '5m', `${day}.jsonl.gz`))).toString().trim().split('\n').length, 2)
  assert.equal(finalizeDays(Date.now(), dir).finalized.length, 0, 'idempotent')
  assert.equal(readFrames(y.getTime() - 1, y.getTime() + 3600000, dir).length, 10)
  fs.rmSync(dir, { recursive: true, force: true })
  delete process.env.JSTACK_PERF_DIR
})

// ---------- the optimize loop ----------

test('verdict adopts only when faster, lighter on CPU and on peak memory, with the same result', () => {
  const run = (wallMs, cpuMs, peakMb) => ({ wallMs, cpuMs, peakMb })
  const A = [run(100, 80, 50), run(110, 85, 52), run(105, 90, 51)]
  assert.equal(verdict(A, [run(60, 40, 30), run(70, 45, 31), run(65, 50, 29)], true).verdict, 'adopt')
  const fasterButHeavier = verdict(A, [run(60, 40, 90), run(70, 45, 91), run(65, 50, 89)], true)
  assert.equal(fasterButHeavier.verdict, 'reject')
  assert.match(fasterButHeavier.why, /peak/)
  assert.equal(verdict(A, [run(60, 40, 30), run(70, 45, 31), run(65, 50, 29)], false).verdict, 'reject')
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([4, 1, 2, 3]), 2.5)
})

test('parseTime reads relative and absolute times', () => {
  const now = Date.parse('2026-10-25T12:00:00Z')
  assert.equal(parseTime('15m', now), now - 900000)
  assert.equal(parseTime('2026-10-25T11:00:00Z', now), now - 3600000)
  assert.equal(parseTime(undefined, now), null)
  assert.throws(() => parseTime('yesterday-ish', now))
})

test('task XML is battery-safe, least privilege, no admin', () => {
  const xml = taskXml({ launcher: 'C:\\x\\launch.vbs', intervalMin: 5 })
  assert.match(xml, /<DisallowStartIfOnBatteries>false</)
  assert.match(xml, /<StopIfGoingOnBatteries>false</)
  assert.match(xml, /<RunLevel>LeastPrivilege</)
  assert.match(xml, /<Interval>PT5M</)
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew</)
})

test('proc-table: perf-snap rows in the guard hooks shape, null when perf-snap is missing', async () => {
  const { toRows, listProcessesFast } = await import('./proc-table.mjs')
  const create = FT(Date.parse('2026-10-25T12:00:00Z'))
  const rows = toRows(parseSnap(`P\t42\t7\t${create}\tnode.exe\t1\t2\t3\t4\t5\t6\t7\nD\t42\t${create}\tC:/x/\tnode a.js\nP\t9\t0\t0\tSystem\t1\t2\t3\t4\t5\t6\t7\n`))
  assert.deepEqual(rows[0], { p: 42, pp: 7, n: 'node.exe', c: 'node a.js', t: Date.parse('2026-10-25T12:00:00Z') })
  assert.deepEqual(rows[1], { p: 9, pp: 0, n: 'System', c: '', t: 0 })
  assert.equal(listProcessesFast({ exe: path.join(os.tmpdir(), 'no-such-perf-snap.exe') }), null)
})
