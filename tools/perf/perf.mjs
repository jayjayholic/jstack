#!/usr/bin/env node
// Machine performance monitor: install the collector, query the store, draw the panel, run the optimize loop.
//   perf.mjs install [--interval 60] [--task JstackPerf] [--lock-dirs a;b] [--queue file] [--mem-map file]
//   perf.mjs uninstall [--purge]          remove the task and stop the collector (--purge also deletes the data)
//   perf.mjs status [--json]              collector alive?, last tick, its own measured cost, store size
//   perf.mjs top [--since 60m] [--until t] [--by name|agent|wt|kind|both] [--sort cpu|mem] [--limit 15] [--json]
//   perf.mjs agents [--since 60m]         = top --by agent
//   perf.mjs spikes [--since 24h] [--cpu 85] [--mem 90] [--json]
//   perf.mjs at <time> [--window 5m]      what ran around a moment (a freeze): machine, groups, heaviest processes, locks
//   perf.mjs patterns [--since 24h]       grep storms, duplicate typechecks, parallel builds, long-lived browsers, idle servers
//   perf.mjs panel [--since 24h] [--out file] [--open]
//   perf.mjs bench --consumer X --a "<cmd>" --b "<cmd>" [--runs 3] [--same output|exit] [--cwd dir] [--alt name] [--source url] [--record]
//   perf.mjs ledger [list|add --consumer X --verdict adopt|reject|in-progress-elsewhere|no-alternative ...] [--json]
//   perf.mjs csv [--since 24h]            per tick and group, for Grafana's CSV data source or a spreadsheet
//   perf.mjs finalize                     compress past days, write rollups, apply retention (the collector does it daily)
// Times: 15m, 2h, 7d (ago) or anything Date.parse reads. Store: ~/.jstack/perf (JSTACK_PERF_DIR).
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { top, spikes, patterns, localDay } from './lib.mjs'
import { storeDir, loadConfig, saveConfig, readFrames, readLines, finalizeDays, loadAgents, labeler, appendLedger, readLedger, dirSizeMb } from './store.mjs'
import { buildPanelData, renderPanel } from './panel.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DIR = storeDir()

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const k = a.slice(2)
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('--')) out[k] = true
      else { out[k] = v; i++ }
    } else out._.push(a)
  }
  return out
}

function parseTime(v, now = Date.now()) {
  if (v === undefined || v === true) return null
  const m = String(v).match(/^(\d+(?:\.\d+)?)(s|m|h|d)$/)
  if (m) return now - +m[1] * { s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7 }[m[2]]
  const t = Date.parse(v)
  if (Number.isNaN(t)) throw new Error(`can't read time "${v}"`)
  return t
}
function parseDur(v, dflt) { const m = String(v ?? dflt).match(/^(\d+)(s|m|h)$/); return m ? +m[1] * { s: 1e3, m: 6e4, h: 3.6e6 }[m[2]] : 3e5 }

function window(args, dfltSince) {
  const to = parseTime(args.until) ?? Date.now()
  const from = parseTime(args.since ?? dfltSince, to)
  return { from, to, frames: readFrames(from, to, DIR) }
}

function printTable(rows, cols) {
  if (!rows.length) { console.log('(nothing in this window)'); return }
  const w = cols.map(c => Math.max(c[0].length, ...rows.map(r => String(c[1](r)).length)))
  console.log(cols.map((c, i) => c[0].padEnd(w[i])).join('  '))
  for (const r of rows) console.log(cols.map((c, i) => String(c[1](r)).padEnd(w[i])).join('  '))
}

const gb = mb => `${(mb / 1024).toFixed(2)} GB`

function cmdTop(args, by = args.by ?? 'name') {
  const { from, to, frames } = window(args, '60m')
  const labelOf = labeler(loadAgents(DIR))
  const sort = args.sort === 'mem' ? (a, b) => b.memMeanMb - a.memMeanMb : (a, b) => b.cpuMean - a.cpuMean
  const rows = top(frames, { by, labelOf }).sort(sort).slice(0, +(args.limit ?? 15))
  if (args.json) return console.log(JSON.stringify({ from: new Date(from).toISOString(), to: new Date(to).toISOString(), frames: frames.length, by, rows }, null, 1))
  console.log(`${by} over ${frames.length} ticks, ${new Date(from).toLocaleString()} to ${new Date(to).toLocaleString()} (CPU: 100% = one core)`)
  printTable(rows, [[by, r => r.key.slice(0, 60)], ['cpu mean', r => `${r.cpuMean}%`], ['cpu max', r => `${r.cpuMax}%`], ['cpu s', r => r.cpuSec], ['ram mean', r => gb(r.memMeanMb)], ['ram max', r => gb(r.memMaxMb)], ['procs', r => r.nMax], ['mostly', r => r.top.join(', ').slice(0, 70)]])
}

function cmdSpikes(args) {
  const { frames } = window(args, '24h')
  const rows = spikes(frames, { cpu: +(args.cpu ?? 85), mem: +(args.mem ?? 90), labelOf: labeler(loadAgents(DIR)) })
  if (args.json) return console.log(JSON.stringify(rows, null, 1))
  if (!rows.length) return console.log('no spikes in this window')
  for (const s of rows) console.log(`${s.start}  ${s.minutes} min  cpu ${s.peakCpu}%  ram ${s.peakUsedPct}%\n  cpu: ${s.topCpu.map(t => `${t.key} ${t.cpuMean}%`).join(' | ')}\n  ram: ${s.topMem.map(t => `${t.key} ${gb(t.memMaxMb)}`).join(' | ')}`)
}

function cmdAt(args) {
  const at = parseTime(args._[1] ?? args.time)
  if (!at) throw new Error('perf.mjs at <time>')
  const half = parseDur(args.window, '5m') / 2
  const frames = readFrames(at - half, at + half, DIR)
  const labelOf = labeler(loadAgents(DIR))
  const procs = new Map()
  for (const f of frames) for (const p of f.p ?? []) {
    const a = procs.get(p[0]) ?? { pid: p[0], name: p[1], kind: p[2], agent: labelOf(p[3]), cpuMax: 0, memMaxMb: 0, ageMin: p[6], cmd: p[7] }
    a.cpuMax = Math.max(a.cpuMax, p[4]); a.memMaxMb = Math.max(a.memMaxMb, p[5]); procs.set(p[0], a)
  }
  const out = {
    window: [new Date(at - half).toISOString(), new Date(at + half).toISOString()],
    machine: frames.map(f => ({ t: new Date(f.t).toISOString(), cpu: f.m.cpu?.[1], usedPct: f.m.usedPct?.[1], availMb: f.m.availMb?.[0], commitMb: f.m.commitMb?.[0], diskBusy: f.m.diskBusy?.[1], dq: f.m.dq?.[1], unacc: f.m.unacc?.[0] })),
    groups: top(frames, { by: 'both', labelOf }).sort((a, b) => b.cpuMean - a.cpuMean).slice(0, 15),
    processes: [...procs.values()].sort((a, b) => b.cpuMax - a.cpuMax).slice(0, 20),
    locks: [...new Set(frames.flatMap(f => (f.lock ?? []).map(l => `${l[0]} ${l[1]} ${labelOf(l[2])}`)))],
  }
  if (args.json) return console.log(JSON.stringify(out, null, 1))
  console.log(`== machine ${out.window.join(' .. ')}`)
  printTable(out.machine, [['time', r => r.t.slice(11, 19)], ['cpu', r => `${r.cpu}%`], ['ram', r => `${r.usedPct}%`], ['avail', r => gb(r.availMb)], ['commit', r => gb(r.commitMb)], ['disk', r => `${r.diskBusy}%`], ['queue', r => r.dq], ['short-lived', r => `${r.unacc}%`]])
  console.log('== busiest groups (process | agent)')
  printTable(out.groups, [['group', r => r.key.slice(0, 70)], ['cpu mean', r => `${r.cpuMean}%`], ['cpu max', r => `${r.cpuMax}%`], ['ram max', r => gb(r.memMaxMb)], ['procs', r => r.nMax]])
  console.log('== heaviest processes')
  printTable(out.processes, [['pid', r => r.pid], ['name', r => r.name], ['agent', r => r.agent.slice(0, 40)], ['cpu', r => `${r.cpuMax}%`], ['ram', r => gb(r.memMaxMb)], ['age', r => `${r.ageMin}m`], ['cmd', r => r.cmd.slice(0, 90)]])
  console.log(`== lock slots held: ${out.locks.join(' | ') || 'none'}`)
}

function cmdPatterns(args) {
  const { frames } = window(args, '24h')
  const rows = patterns(frames, { labelOf: labeler(loadAgents(DIR)) })
  if (args.json) return console.log(JSON.stringify(rows, null, 1))
  if (!rows.length) return console.log('no known waste pattern in this window')
  for (const r of rows) console.log(`${r.pattern}: ${r.evidence}\n  fix: ${r.fix}`)
}

function collectorPid() {
  try {
    const file = path.join(DIR, 'collector.pid')
    const pid = +fs.readFileSync(file, 'utf8').trim()
    process.kill(pid, 0)
    return { pid, lastTickSec: Math.round((Date.now() - fs.statSync(file).mtimeMs) / 1000) }
  } catch { return null }
}

function cmdStatus(args) {
  const cfg = loadConfig(DIR)
  const c = collectorPid()
  const frames = readFrames(Date.now() - 3600000, Date.now(), DIR)
  const self = frames.map(f => f.self).filter(Boolean)
  const mean = k => self.length ? Math.round(self.reduce((s, x) => s + (x[k] ?? 0), 0) / self.length * 100) / 100 : null
  const max = k => self.length ? Math.max(...self.map(x => x[k] ?? 0)) : null
  const cores = frames[frames.length - 1]?.m.cores?.[0] ?? 1
  const snapPct = mean('snapCpuMs') == null ? null : Math.round(mean('snapCpuMs') / (cfg.intervalSec * 10) * 100) / 100
  const out = {
    store: DIR, sizeMb: dirSizeMb(DIR), collector: c ? `running, pid ${c.pid}, last tick ${c.lastTickSec}s ago` : 'NOT running',
    intervalSec: cfg.intervalSec, task: cfg.taskName, ticksLastHour: frames.length,
    overhead: { collectorCpuPctOfOneCore: mean('cpu'), snapCpuPctOfOneCore: snapPct, machinePct: mean('cpu') == null ? null : Math.round(((mean('cpu') ?? 0) + (snapPct ?? 0)) / cores * 1000) / 1000, collectorRssMb: mean('rssMb'), collectorRssMaxMb: max('rssMb'), collectorPrivateMb: mean('privMb'), snapPeakMb: max('snapPeakMb'), tickMs: mean('tickMs') },
    retention: { rawDays: cfg.rawDays, fiveMinDays: cfg.fiveMinDays, hourDays: cfg.hourDays },
  }
  if (args.json) return console.log(JSON.stringify(out, null, 1))
  console.log(JSON.stringify(out, null, 1))
}

function openFile(file) {
  if (process.platform === 'win32') spawn('cmd.exe', ['/c', 'start', '', file], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [file], { detached: true, stdio: 'ignore' }).unref()
}

function cmdPanel(args) {
  const { from, to, frames } = window(args, '24h')
  const data = buildPanelData(frames, { labelOf: labeler(loadAgents(DIR)), from, to, ledger: readLedger(DIR) })
  const out = args.out && args.out !== true ? path.resolve(args.out) : path.join(DIR, 'panel.html')
  fs.writeFileSync(out, renderPanel(data))
  console.log(out)
  if (args.open) openFile(out)
}

function cmdCsv(args) {
  const { frames } = window(args, '24h')
  const labelOf = labeler(loadAgents(DIR))
  const q = v => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)
  console.log('time,name,kind,agent,cpu_mean_pct,cpu_max_pct,priv_mean_mb,priv_max_mb,procs')
  for (const f of frames) for (const r of f.g) console.log([new Date(f.t).toISOString(), r[0], r[1], labelOf(r[2]), r[3], r[4], r[5], r[6], r[7]].map(q).join(','))
}

// ---------- the optimize loop ----------

const median = xs => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null }

// Verdict rule: adopt only when B is faster (wall), lighter on CPU and lighter on peak memory than A, all medians,
// and gave the same result on every run.
function verdict(a, b, same) {
  if (!same) return { verdict: 'reject', why: 'results differ' }
  const ma = { wall: median(a.map(r => r.wallMs)), cpu: median(a.map(r => r.cpuMs)), peak: median(a.map(r => r.peakMb)) }
  const mb = { wall: median(b.map(r => r.wallMs)), cpu: median(b.map(r => r.cpuMs)), peak: median(b.map(r => r.peakMb)) }
  const worse = ['wall', 'cpu', 'peak'].filter(k => !(mb[k] < ma[k]))
  return { a: ma, b: mb, verdict: worse.length ? 'reject' : 'adopt', why: worse.length ? `not better on ${worse.join(', ')}` : 'faster, less CPU and lower peak memory, same result' }
}

function measure(cmdline, cwd) {
  const out = path.join(DIR, `bench-${process.pid}-${crypto.randomBytes(4).toString('hex')}.out`)
  const exe = process.env.JSTACK_PERF_SNAP || path.join(DIR, 'bin', 'perf-snap.exe')
  const r = spawnSync(exe, ['run', out, cmdline], { encoding: 'utf8', cwd, windowsHide: true, maxBuffer: 1 << 20 })
  if (r.status !== 0) throw new Error(`perf-snap run failed: ${r.stderr || r.error?.message}`)
  const res = JSON.parse(r.stdout.trim())
  const body = fs.readFileSync(out)
  fs.rmSync(out, { force: true })
  return { ...res, hash: crypto.createHash('sha256').update(body).digest('hex').slice(0, 16), bytes: body.length }
}

function cmdBench(args) {
  if (process.platform !== 'win32') throw new Error('bench measures the process tree with a Windows Job Object; on macOS/Linux it is not built yet (TODO)')
  if (!args.a || !args.b || !args.consumer) throw new Error('perf.mjs bench --consumer X --a "<cmd>" --b "<cmd>" [--runs 3]')
  const runs = Math.max(3, +(args.runs ?? 3))
  const cwd = args.cwd && args.cwd !== true ? args.cwd : process.cwd()
  const A = []
  const B = []
  // Interleaved, alternating which goes first each round, so a warming cache or a busy minute hits both sides.
  for (let i = 0; i < runs; i++) {
    const order = i % 2 ? [['b', B], ['a', A]] : [['a', A], ['b', B]]
    for (const [k, list] of order) list.push(measure(args[k], cwd))
  }
  const sameBy = args.same === 'exit' ? r => String(r.exit) : r => `${r.exit}:${r.hash}`
  const same = new Set([...A, ...B].map(sameBy)).size === 1
  const v = verdict(A, B, same)
  const entry = {
    consumer: args.consumer, alternative: args.alt && args.alt !== true ? args.alt : args.b, baseline: args.a, source: args.source && args.source !== true ? args.source : '',
    runs, compare: args.same === 'exit' ? 'exit code' : 'exit code + output hash', same,
    numbers: v.a ? `wall ${v.a.wall}->${v.b.wall} ms, cpu ${v.a.cpu}->${v.b.cpu} ms, peak ${v.a.peak}->${v.b.peak} MB (medians of ${runs})` : '',
    verdict: v.verdict, why: v.why, raw: { a: A, b: B },
  }
  if (args.record) appendLedger(entry, DIR)
  console.log(JSON.stringify(entry, null, 1))
}

function cmdLedger(args) {
  const sub = args._[1] ?? 'list'
  if (sub === 'add') {
    if (!args.consumer || !args.verdict) throw new Error('ledger add --consumer X --verdict adopt|reject|in-progress-elsewhere|no-alternative [--alternative ..] [--numbers ..] [--why ..] [--source ..]')
    const entry = {}
    for (const k of ['consumer', 'evidence', 'alternative', 'source', 'numbers', 'verdict', 'why']) if (args[k] && args[k] !== true) entry[k] = args[k]
    appendLedger(entry, DIR)
    return console.log('recorded')
  }
  const rows = readLedger(DIR)
  if (args.json) return console.log(JSON.stringify(rows, null, 1))
  printTable(rows, [['when', r => (r.at ?? '').slice(0, 16)], ['consumer', r => r.consumer], ['alternative', r => String(r.alternative ?? '').slice(0, 40)], ['verdict', r => r.verdict], ['numbers / why', r => `${r.numbers ?? ''} ${r.why ?? ''}`.trim().slice(0, 110)]])
}

// ---------- install ----------

function cscPath() {
  const win = process.env.WINDIR || 'C:\\Windows'
  return [path.join(win, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'), path.join(win, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')].find(p => fs.existsSync(p))
}

function taskXml({ launcher, intervalMin }) {
  const user = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
  const x = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>jstack machine performance collector (tools/perf). Starts at logon; every ${intervalMin} min it restarts the collector if it died (a running one makes the new start exit).</Description></RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled><UserId>${x(user)}</UserId></LogonTrigger>
    <TimeTrigger><Repetition><Interval>PT${intervalMin}M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>2020-01-01T00:00:00</StartBoundary><Enabled>true</Enabled></TimeTrigger>
  </Triggers>
  <Principals><Principal id="Author"><UserId>${x(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <ExecutionTimeLimit>PT5M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author"><Exec><Command>wscript.exe</Command><Arguments>"${x(launcher)}"</Arguments></Exec></Actions>
</Task>
`
}

function cmdInstall(args) {
  const cfg = loadConfig(DIR)
  if (args.interval) cfg.intervalSec = Math.max(5, +args.interval)
  if (args.task) cfg.taskName = args.task
  if (args['lock-dirs']) cfg.lockDirs = String(args['lock-dirs']).split(/[;,]/).filter(Boolean)
  if (args.queue) cfg.queueFile = args.queue
  for (const k of ['raw-days', 'five-min-days', 'hour-days']) if (args[k]) cfg[{ 'raw-days': 'rawDays', 'five-min-days': 'fiveMinDays', 'hour-days': 'hourDays' }[k]] = +args[k]
  const app = path.join(DIR, 'app')
  fs.mkdirSync(path.join(app, 'perf'), { recursive: true })
  fs.mkdirSync(path.join(app, 'memory'), { recursive: true })
  for (const f of fs.readdirSync(HERE)) if (f.endsWith('.mjs') && !f.endsWith('.test.mjs')) fs.copyFileSync(path.join(HERE, f), path.join(app, 'perf', f))
  fs.copyFileSync(path.join(HERE, '..', 'memory', 'secrets.mjs'), path.join(app, 'memory', 'secrets.mjs'))
  const memMapSrc = args['mem-map'] && args['mem-map'] !== true ? args['mem-map'] : path.join(HERE, '..', 'mem-map.ps1')
  if (fs.existsSync(memMapSrc)) { fs.copyFileSync(memMapSrc, path.join(app, 'mem-map.ps1')); cfg.memMap = path.join(app, 'mem-map.ps1') }
  saveConfig(cfg, DIR)
  if (process.platform !== 'win32') {
    console.log(`copied to ${app}. Not Windows: start it at login yourself, e.g. a launchd agent or systemd --user unit running\n  JSTACK_PERF_DIR=${DIR} node ${path.join(app, 'perf', 'collect.mjs')}\n(UNVERIFIED on macOS/Linux)`)
    return
  }
  const csc = cscPath()
  if (!csc) throw new Error('no C# compiler found (.NET Framework 4 csc.exe ships with Windows 10/11)')
  fs.mkdirSync(path.join(DIR, 'bin'), { recursive: true })
  const running = collectorPid()
  if (running) { try { process.kill(running.pid) } catch { /* already gone */ } }
  const exe = path.join(DIR, 'bin', 'perf-snap.exe')
  const c = spawnSync(csc, ['-nologo', '-optimize+', '-platform:x64', `-out:${exe}`, path.join(HERE, 'perf-snap.cs')], { encoding: 'utf8', windowsHide: true })
  if (c.status !== 0) throw new Error(`csc failed: ${c.stdout}${c.stderr}`)
  const launcher = path.join(app, 'launch.vbs')
  const vb = s => s.replace(/"/g, '""')
  fs.writeFileSync(launcher, [
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Environment("PROCESS")("JSTACK_PERF_DIR") = "${vb(DIR)}"`,
    `sh.Run """${vb(process.execPath)}"" ""${vb(path.join(app, 'perf', 'collect.mjs'))}""", 0, False`,
    '',
  ].join('\r\n'))
  const xml = path.join(app, 'task.xml')
  fs.writeFileSync(xml, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(taskXml({ launcher, intervalMin: 5 }), 'utf16le')]))
  const r = spawnSync('schtasks', ['/Create', '/TN', cfg.taskName, '/XML', xml, '/F'], { encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) throw new Error(`schtasks /Create failed: ${r.stdout}${r.stderr}`)
  spawnSync('schtasks', ['/Run', '/TN', cfg.taskName], { encoding: 'utf8', windowsHide: true })
  console.log(`installed: task ${cfg.taskName} (at logon + every 5 min if it died, battery-safe, no admin), collector every ${cfg.intervalSec}s, store ${DIR}`)
}

function cmdUninstall(args) {
  const cfg = loadConfig(DIR)
  if (process.platform === 'win32') spawnSync('schtasks', ['/Delete', '/TN', cfg.taskName, '/F'], { encoding: 'utf8', windowsHide: true })
  const c = collectorPid()
  if (c) { try { process.kill(c.pid) } catch { /* gone */ } }
  fs.rmSync(path.join(DIR, 'collector.pid'), { force: true })
  if (args.purge) fs.rmSync(DIR, { recursive: true, force: true })
  console.log(`removed task ${cfg.taskName}${c ? `, stopped collector ${c.pid}` : ''}${args.purge ? `, deleted ${DIR}` : `; data kept in ${DIR}`}`)
}

const COMMANDS = {
  top: a => cmdTop(a), agents: a => cmdTop(a, 'agent'), spikes: cmdSpikes, at: cmdAt, patterns: cmdPatterns, status: cmdStatus, panel: cmdPanel,
  csv: cmdCsv, bench: cmdBench, ledger: cmdLedger, install: cmdInstall, uninstall: cmdUninstall,
  finalize: () => console.log(JSON.stringify(finalizeDays(Date.now(), DIR))),
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  const fn = COMMANDS[args._[0]]
  if (!fn) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 17).map(l => l.replace(/^\/\/ ?/, '')).join('\n'))
    process.exit(args._[0] ? 2 : 0)
  }
  try { fn(args) } catch (e) { console.error(`perf: ${e.message}`); process.exit(1) }
}

export { parseArgs, parseTime, verdict, median, taskXml, readLines, localDay }
