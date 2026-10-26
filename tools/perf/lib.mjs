// Pure functions of the machine performance monitor: parse a snapshot, CPU deltas, attribution, redaction,
// tick records, rollups and retention. No I/O except the cached .git lookups in repoRootOf. Plain Node, no deps.
import fs from 'node:fs'
import path from 'node:path'
import { redact, shannon } from '../memory/secrets.mjs'

const FILETIME_EPOCH_MS = 11644473600000
const MB = 1048576

// ---------- parsing ----------

// perf-snap.exe output: M (machine), P (process), D (cwd + command line for new processes), S (its own cost).
function parseSnap(text) {
  const out = { machine: null, procs: [], details: new Map(), self: null }
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue
    const f = line.split('\t')
    if (f[0] === 'P') {
      out.procs.push({
        pid: +f[1], ppid: +f[2], create: f[3], name: f[4], cpu: +f[5], priv: +f[6], ws: +f[7],
        rd: +f[8], wr: +f[9], threads: +f[10], handles: +f[11],
      })
    } else if (f[0] === 'D') {
      out.details.set(`${f[1]}:${f[2]}`, { cwd: f[3] ?? '', cmd: f.slice(4).join(' ') })
    } else if (f[0] === 'M') {
      out.machine = {
        idle: +f[1], kernel: +f[2], user: +f[3], totalPhys: +f[4], availPhys: +f[5], commit: +f[6], commitLimit: +f[7],
        cache: +f[8], paged: +f[9], nonpaged: +f[10], pfTotal: +f[11], pfUsed: +f[12], diskQueue: +f[13], disks: +f[14],
        diskIdle: +f[15], diskQuery: +f[16], diskRead: +f[17], diskWrite: +f[18], procCount: +f[19], cores: +f[20],
      }
    } else if (f[0] === 'S') {
      out.self = { cpu100ns: +f[1], peakWs: +f[2], priv: +f[3] }
    }
  }
  return out
}

// macOS / Linux: `ps -axww -o pid=,ppid=,rss=,time=,comm=` then args on a second pass. UNVERIFIED on a real Mac.
// ps TIME is [[dd-]hh:]mm:ss[.cc]; we keep it in the same 100 ns units as Windows.
function psTimeTo100ns(t) {
  let days = 0
  let s = String(t).trim()
  const dash = s.indexOf('-')
  if (dash > 0) { days = +s.slice(0, dash); s = s.slice(dash + 1) }
  const parts = s.split(':').map(Number)
  let sec = 0
  for (const p of parts) sec = sec * 60 + p
  return Math.round((days * 86400 + sec) * 1e7)
}

function parsePs(text) {
  const procs = []
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)
    if (!m) continue
    const name = path.posix.basename(m[5].trim()) || 'unknown'
    procs.push({ pid: +m[1], ppid: +m[2], create: name, name, cpu: psTimeTo100ns(m[4]), priv: +m[3] * 1024, ws: +m[3] * 1024, rd: 0, wr: 0, threads: 0, handles: 0 })
  }
  return procs
}

// ---------- CPU math ----------

// CPU % over the interval, 100 = one core fully busy (the Grafana panel's convention). A process first seen this
// tick counts its whole lifetime only if it started after the previous snapshot; otherwise it has no baseline.
function cpuPct(prevCpu, curCpu, dtSec, { createdAfterPrev = false, cores = 1 } = {}) {
  if (!(dtSec > 0)) return 0
  let d
  if (prevCpu === undefined) d = createdAfterPrev ? curCpu : 0
  else d = curCpu >= prevCpu ? curCpu - prevCpu : 0
  const pct = (d / 1e7 / dtSec) * 100
  return pct > cores * 100 * 1.05 ? 0 : pct
}

// Machine CPU % of ALL cores from GetSystemTimes (kernel time includes idle).
function machineCpuPct(prev, cur) {
  const idle = cur.idle - prev.idle
  const total = (cur.kernel - prev.kernel) + (cur.user - prev.user)
  if (!(total > 0)) return 0
  return Math.max(0, Math.min(100, (1 - idle / total) * 100))
}

function filetimeToMs(ft) { return Number(BigInt(ft) / 10000n) - FILETIME_EPOCH_MS }

// ---------- attribution (mirrors mem-map.ps1; the parity test runs both) ----------

const KIND_RULES = [
  [(n, c) => n === 'claude.exe' || n === 'claude' || /claude-code|@anthropic-ai/i.test(c), 'claude'],
  [(n, c) => /mcp/i.test(c), 'mcp'],
  [(n, c) => /next(\.js)?["']?\s+build|next[\\/]dist[\\/]build/i.test(c), 'next-build'],
  [(n, c) => /next(\.js)?["']?\s+dev/i.test(c), 'next-dev'],
  [(n, c) => /next(\.js)?["']?\s+start|next-server|start-server\.js/i.test(c), 'next-server'],
  [(n, c) => /typescript[\\/]lib[\\/]tsc|\btsc(\.exe|\.js)?\b|tsgo/i.test(c), 'tsc'],
  [(n, c) => /vitest|jest-worker|bun(\.exe)?["']?\s+test/i.test(c), 'tests'],
  [(n, c) => /playwright|--headless|remote-debugging/i.test(c), 'browser'],
  [(n) => ['grep.exe', 'rg.exe', 'find.exe', 'grep', 'rg', 'find'].includes(n), 'grep'],
  [(n, c) => (n === 'tail.exe' || n === 'tail') && /\s-[a-zA-Z]*[fF]/.test(c), 'tail-f'],
  [(n) => n === 'tail.exe' || n === 'tail', 'tail'],
  [(n) => n === 'sleep.exe' || n === 'sleep', 'sleep'],
  [(n, c) => ['bash.exe', 'sh.exe', 'bash', 'sh'].includes(n) && /while|for\s|until|sleep/i.test(c), 'bash-loop'],
  [(n) => ['bash.exe', 'sh.exe', 'bash', 'sh'].includes(n), 'bash'],
]

function kindOf(name, cmd = '') {
  const n = String(name).toLowerCase()
  const c = String(cmd ?? '')
  for (const [test, kind] of KIND_RULES) if (test(n, c)) return kind
  return n.replace(/\.exe$/, '')
}

function worktreeOf(text) {
  if (!text) return ''
  let m = text.match(/[A-Za-z]:[\\/][^"'<>|*?\r\n]*?[\\/]\.?worktrees[\\/][^\\/"' ]+/i)
  if (m) return m[0].replace(/\//g, '\\').replace(/\\+$/, '')
  // A node_modules path names a project, except a global install (npm -g, bun -g under AppData or Program Files).
  m = text.match(/([A-Za-z]:[\\/][^"'<>|*?\r\n ]*?)[\\/]node_modules[\\/]/i)
  if (m && !/[\\/](AppData|Program Files[^\\/]*)[\\/]/i.test(m[1])) return m[1].replace(/\//g, '\\').replace(/\\+$/, '')
  m = text.match(/(?:^|[\s"'=])(\/[^\s"']*?\/\.?worktrees\/[^/"' ]+)/)
  if (m) return m[1]
  return ''
}

const repoCache = new Map()
function repoRootOf(dir, exists = p => fs.existsSync(p)) {
  if (!dir) return ''
  const key = dir.replace(/[\\/]+$/, '')
  if (/^[A-Za-z]:\\(windows|program files|programdata)/i.test(key) || /^\/(usr|bin|sbin|System|Library|private|proc)(\/|$)/.test(key)) return ''
  if (repoCache.has(key)) return repoCache.get(key)
  let d = key
  let found = ''
  for (let i = 0; i < 12 && d; i++) {
    if (exists(path.join(d, '.git'))) { found = d; break }
    const up = path.dirname(d)
    if (up === d) break
    d = up
  }
  repoCache.set(key, found)
  return found
}

const ROOT_STOP = new Set(['explorer.exe', 'services.exe', 'wininit.exe', 'winlogon.exe', 'svchost.exe', 'userinit.exe', 'smss.exe', 'csrss.exe', 'system', 'launchd', 'init', 'systemd', 'kernel_task'])

// Parent links that survive PID reuse: a "parent" younger than its child is a different process.
function buildParents(procs) {
  const byPid = new Map(procs.map(p => [p.pid, p]))
  const parent = new Map()
  for (const p of procs) {
    const pp = byPid.get(p.ppid)
    if (pp && pp !== p && (typeof pp.create !== 'string' || typeof p.create !== 'string' || !/^\d+$/.test(p.create) || BigInt(pp.create) <= BigInt(p.create))) parent.set(p.pid, pp)
  }
  return parent
}

// Top-most ancestor below the session roots (explorer, services...): what the Mac panel calls "root".
function appRootOf(p, parent) {
  let cur = p
  for (let i = 0; i < 64; i++) {
    const up = parent.get(cur.pid)
    if (!up || ROOT_STOP.has(up.name.toLowerCase())) break
    cur = up
  }
  return cur.name.toLowerCase().replace(/\.exe$/, '')
}

// Each process -> worktree (its cwd, its repo root, its command line, else an ancestor's), else "app:<root>".
function attribute(procs, details, parent, { repoRoot = repoRootOf } = {}) {
  const own = new Map()
  for (const p of procs) {
    const d = details.get(`${p.pid}:${p.create}`) ?? {}
    p.cwd = d.cwd ?? ''
    p.cmd = d.cmd ?? ''
    let wt = worktreeOf(p.cwd)
    if (!wt && p.cwd) wt = repoRoot(p.cwd)
    if (!wt) wt = worktreeOf(p.cmd)
    own.set(p.pid, wt)
  }
  for (const p of procs) {
    let wt = own.get(p.pid)
    let cur = p
    for (let i = 0; !wt && i < 40; i++) {
      cur = parent.get(cur.pid)
      if (!cur || ROOT_STOP.has(cur.name.toLowerCase())) break
      wt = own.get(cur.pid)
    }
    p.kind = kindOf(p.name, p.cmd)
    p.wt = wt || `app:${appRootOf(p, parent)}`
  }
  return procs
}

// ---------- redaction ----------

const SECRET_WORD = '(?:token|secret|password|passwd|pwd|api[-_]?key|apikey|auth|credential|cookie|session|private[-_]?key|access[-_]?key|client[-_]?secret|signature|bearer)'
const FLAG_RE = new RegExp(`(--?[\\w.-]*${SECRET_WORD}[\\w.-]*)(=|\\s+)("[^"]*"|'[^']*'|[^\\s"']+)`, 'gi')
const ENV_RE = /\b([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PWD|KEY|AUTH|CREDENTIAL|COOKIE|SESSION)[A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s"']+)/gi
const SCHEME_RE = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi
const URL_CRED_RE = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/'"]+:)[^\s@/'"]+@/gi
const QUERY_RE = /([?&](?:token|key|apikey|api_key|access_token|refresh_token|auth|sig|signature|password|secret|code|session)=)[^&\s"']+/gi
const BLOB_RE = /(?<![\\/\w.-])[A-Za-z0-9+_-]{32,}={0,2}(?![\\/\w])/g

// Command lines can carry tokens (--token=..., KEY=value, Bearer ..., URLs with credentials). Everything that looks
// like one is replaced before anything is written; then the line is cut to `max` characters.
function redactCmd(cmd, max = 300) {
  if (!cmd) return ''
  let s = redact(String(cmd)).text
  s = s.replace(FLAG_RE, (m, flag, sep) => `${flag}${sep}[REDACTED]`)
  s = s.replace(ENV_RE, (m, name) => `${name}=[REDACTED]`)
  s = s.replace(SCHEME_RE, (m, scheme) => `${scheme} [REDACTED]`)
  s = s.replace(URL_CRED_RE, '$1[REDACTED]@')
  s = s.replace(QUERY_RE, '$1[REDACTED]')
  // Long random-looking strings carry digits and letters; CONSTANT_NAMES and plain words are left alone.
  s = s.replace(BLOB_RE, m => (/\d/.test(m) && /[a-z]/i.test(m) && !/^[A-Z][A-Z0-9_]*$/.test(m) && shannon(m) >= 3.5 ? '[REDACTED]' : m))
  s = s.replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}...` : s
}

// ---------- ticks ----------

const r1 = v => Math.round(v * 10) / 10

// One tick record from two snapshots. state: { at, cpu: Map key->cpu100ns, io: Map key->bytes, machine } of the
// previous tick. Returns { record, state } (the next state).
function buildTick(prev, cur, { at, procs, machine, locks = [], self = null, notableCpu = 5, notableMb = 500, maxNotable = 40, minGroupCpu = 0.1, minGroupMb = 10 }) {
  const dt = prev ? (at - prev.at) / 1000 : 0
  const cores = machine.cores || 1
  const nextCpu = new Map()
  const nextIo = new Map()
  const groups = new Map()
  const notable = []
  let sumCpu = 0
  for (const p of procs) {
    const key = `${p.pid}:${p.create}`
    nextCpu.set(key, p.cpu)
    nextIo.set(key, p.rd + p.wr)
    const isNew = prev && !prev.cpu.has(key)
    const startedMs = /^\d+$/.test(String(p.create)) && p.create !== '0' ? filetimeToMs(p.create) : NaN
    const createdAfterPrev = isNew && Number.isFinite(startedMs) && startedMs >= prev.at - 1000
    const cpu = prev ? cpuPct(prev.cpu.get(key), p.cpu, dt, { createdAfterPrev, cores }) : 0
    const prevIo = prev?.io.get(key)
    const io = prev && dt > 0 ? (prevIo === undefined ? (createdAfterPrev ? p.rd + p.wr : 0) : Math.max(0, p.rd + p.wr - prevIo)) / dt / 1024 : 0
    p.cpuNow = cpu
    p.ageMin = Number.isFinite(startedMs) ? Math.max(0, Math.round((at - startedMs) / 60000)) : null
    if (p.pid === 0 || /^(idle|system idle process)$/i.test(p.name)) continue
    sumCpu += cpu
    const gk = `${p.name}\u0000${p.kind}\u0000${p.wt}`
    let g = groups.get(gk)
    if (!g) { g = { name: p.name, kind: p.kind, wt: p.wt, n: 0, cpu: 0, priv: 0, ws: 0, io: 0, born: 0 }; groups.set(gk, g) }
    g.n++; g.cpu += cpu; g.priv += p.priv; g.ws += p.ws; g.io += io
    if (createdAfterPrev) g.born++
    const ageMin = p.ageMin
    if (cpu >= notableCpu || p.priv >= notableMb * MB) notable.push([p.pid, p.name, p.kind, p.wt, r1(cpu), Math.round(p.priv / MB), ageMin, redactCmd(p.cmd, 200)])
  }
  const g = []
  const small = new Map()
  for (const x of groups.values()) {
    if (x.cpu < minGroupCpu && x.priv < minGroupMb * MB) {
      const s = small.get(x.name) ?? { name: x.name, kind: '_small', wt: '_small', n: 0, cpu: 0, priv: 0, ws: 0, io: 0, born: 0 }
      s.n += x.n; s.cpu += x.cpu; s.priv += x.priv; s.ws += x.ws; s.io += x.io; s.born += x.born
      small.set(x.name, s)
    } else g.push(x)
  }
  const smallAll = { name: '_small', kind: '_small', wt: '_small', n: 0, cpu: 0, priv: 0, ws: 0, io: 0, born: 0 }
  for (const s of small.values()) { smallAll.n += s.n; smallAll.cpu += s.cpu; smallAll.priv += s.priv; smallAll.ws += s.ws; smallAll.io += s.io; smallAll.born += s.born }
  if (smallAll.n) g.push(smallAll)
  g.sort((a, b) => b.cpu - a.cpu || b.priv - a.priv)
  notable.sort((a, b) => b[4] - a[4] || b[5] - a[5])

  const pm = prev?.machine
  const m = {
    cpu: pm ? r1(machineCpuPct(pm, machine)) : 0,
    availMb: Math.round(machine.availPhys / MB), totalMb: Math.round(machine.totalPhys / MB),
    commitMb: Math.round(machine.commit / MB), commitLimitMb: Math.round(machine.commitLimit / MB),
    cacheMb: Math.round(machine.cache / MB), pagedMb: Math.round(machine.paged / MB), npMb: Math.round(machine.nonpaged / MB),
    pfMb: Math.round(machine.pfUsed / MB), pfTotalMb: Math.round(machine.pfTotal / MB), dq: machine.diskQueue,
    diskBusy: pm && machine.diskQuery > pm.diskQuery ? r1(Math.max(0, 100 * (1 - (machine.diskIdle - pm.diskIdle) / (machine.diskQuery - pm.diskQuery)))) : 0,
    diskRMBs: pm && dt > 0 ? r1(Math.max(0, machine.diskRead - pm.diskRead) / dt / MB) : 0,
    diskWMBs: pm && dt > 0 ? r1(Math.max(0, machine.diskWrite - pm.diskWrite) / dt / MB) : 0,
    procs: machine.procCount || procs.length, cores,
  }
  m.usedPct = m.totalMb ? r1(100 * (1 - m.availMb / m.totalMb)) : 0
  // Machine busy (in one-core units) minus what live processes explain: short-lived processes that started and
  // exited between ticks, plus interrupts/DPCs.
  m.unacc = pm ? r1(Math.max(0, (m.cpu * cores) - sumCpu)) : 0
  const record = {
    t: new Date(at).toISOString(), dt: r1(dt), m,
    g: g.map(x => [x.name, x.kind, x.wt, r1(x.cpu), Math.round(x.priv / MB), Math.round(x.ws / MB), x.n, Math.round(x.io), x.born]),
    p: notable.slice(0, maxNotable),
    lock: locks,
  }
  if (self) record.self = self
  return { record, state: { at, cpu: nextCpu, io: nextIo, machine } }
}

// ---------- frames: raw ticks and rollups read the same way ----------
// frame = { t: ms, res: seconds covered, k: ticks, m: { field: [mean, max] }, g: [[name, kind, wt, cpuMean, cpuMax,
//   privMean, privMax, nMax, wsMean, ioMean]], p?, lock? }

const MACHINE_FIELDS = ['cpu', 'usedPct', 'availMb', 'commitMb', 'commitLimitMb', 'cacheMb', 'pfMb', 'dq', 'diskBusy', 'diskRMBs', 'diskWMBs', 'unacc', 'procs']

function tickToFrame(rec) {
  const m = {}
  for (const f of MACHINE_FIELDS) if (rec.m?.[f] !== undefined) m[f] = [rec.m[f], rec.m[f]]
  m.totalMb = [rec.m?.totalMb ?? 0, rec.m?.totalMb ?? 0]
  m.cores = [rec.m?.cores ?? 1, rec.m?.cores ?? 1]
  return {
    t: Date.parse(rec.t), res: rec.dt || 60, k: 1, m,
    g: (rec.g ?? []).map(r => [r[0], r[1], r[2], r[3], r[3], r[4], r[4], r[6], r[5], r[7]]),
    p: rec.p ?? [], lock: (rec.lock ?? []).map(l => [l[0], l[1], l[3] ?? '', (rec.dt || 60) / 60]), self: rec.self,
  }
}

// Collapse frames into buckets of `res` seconds: means are time-weighted and a group missing from a tick counts 0.
function rollup(frames, res) {
  const buckets = new Map()
  for (const f of frames) {
    const b = Math.floor(f.t / (res * 1000)) * res * 1000
    if (!buckets.has(b)) buckets.set(b, [])
    buckets.get(b).push(f)
  }
  const out = []
  for (const [b, fs] of [...buckets.entries()].sort((x, y) => x[0] - y[0])) {
    const span = fs.reduce((s, f) => s + f.res, 0) || 1
    const m = {}
    for (const f of fs) for (const [k, [mean, max]] of Object.entries(f.m)) {
      const acc = m[k] ?? (m[k] = [0, -Infinity])
      acc[0] += mean * f.res
      acc[1] = Math.max(acc[1], max)
    }
    for (const k of Object.keys(m)) m[k] = [r1(m[k][0] / span), r1(m[k][1])]
    const g = new Map()
    for (const f of fs) for (const r of f.g) {
      const key = `${r[0]}\u0000${r[1]}\u0000${r[2]}`
      const a = g.get(key) ?? [r[0], r[1], r[2], 0, 0, 0, 0, 0, 0, 0]
      a[3] += r[3] * f.res; a[4] = Math.max(a[4], r[4])
      a[5] += r[5] * f.res; a[6] = Math.max(a[6], r[6])
      a[7] = Math.max(a[7], r[7]); a[8] += (r[8] ?? 0) * f.res; a[9] += (r[9] ?? 0) * f.res
      g.set(key, a)
    }
    const rows = [...g.values()].map(a => [a[0], a[1], a[2], r1(a[3] / span), r1(a[4]), Math.round(a[5] / span), a[6], a[7], Math.round(a[8] / span), Math.round(a[9] / span)])
    const lock = new Map()
    for (const f of fs) for (const l of f.lock ?? []) {
      const key = `${l[0]}\u0000${l[1]}\u0000${l[2]}`
      const a = lock.get(key) ?? [l[0], l[1], l[2], 0]
      a[3] += l[3]
      lock.set(key, a)
    }
    out.push({ t: b, res: span, k: fs.reduce((s, f) => s + f.k, 0), m, g: rows, lock: [...lock.values()].map(a => [a[0], a[1], a[2], r1(a[3])]) })
  }
  return out
}

// ---------- retention ----------

const DAY_MS = 86400000
function localDay(ms) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Which store files to delete: raw ticks after rawDays, 5-minute rollups after fiveMinDays, hourly after hourDays.
// files: relative paths like raw/2026-10-01.jsonl.gz, 5m/2026-10-01.jsonl.gz, 1h/2026-10.jsonl.
function expired(files, nowMs, { rawDays = 14, fiveMinDays = 90, hourDays = 400 } = {}) {
  const out = []
  const today = Date.parse(`${localDay(nowMs)}T00:00:00`)
  for (const f of files) {
    const norm = f.replace(/\\/g, '/')
    let m = norm.match(/^(raw|5m)\/(\d{4}-\d{2}-\d{2})\.jsonl(\.gz)?$/)
    if (m) {
      const age = Math.round((today - Date.parse(`${m[2]}T00:00:00`)) / DAY_MS)
      if (age >= (m[1] === 'raw' ? rawDays : fiveMinDays)) out.push(f)
      continue
    }
    m = norm.match(/^1h\/(\d{4})-(\d{2})\.jsonl(\.gz)?$/)
    if (m) {
      const monthEnd = new Date(+m[1], +m[2], 1).getTime()
      if ((today - monthEnd) / DAY_MS >= hourDays) out.push(f)
    }
  }
  return out
}

// ---------- queries over frames ----------

function keyOf(row, by, labelOf) {
  if (by === 'name') return row[0]
  if (by === 'kind') return row[1]
  if (by === 'wt') return row[2]
  if (by === 'agent') return labelOf(row[2])
  return `${row[0]} | ${labelOf(row[2])}`
}

// Mean (over the whole window, absent = 0) and max per key, like the panel's legend. cpu: 100 = one core.
function top(frames, { by = 'name', labelOf = x => x } = {}) {
  const span = frames.reduce((s, f) => s + f.res, 0) || 1
  const acc = new Map()
  for (const f of frames) {
    const perKey = new Map()
    for (const r of f.g) {
      const k = keyOf(r, by, labelOf)
      const a = perKey.get(k) ?? { cpuMean: 0, cpuMax: 0, memMean: 0, memMax: 0, n: 0, sub: new Map() }
      a.cpuMean += r[3]; a.cpuMax += r[4]; a.memMean += r[5]; a.memMax += r[6]; a.n += r[7]
      const sk = by === 'name' ? labelOf(r[2]) : r[0]
      a.sub.set(sk, (a.sub.get(sk) ?? 0) + r[3] + r[5] / 1000)
      perKey.set(k, a)
    }
    for (const [k, a] of perKey) {
      const t = acc.get(k) ?? { key: k, cpuMean: 0, cpuMax: 0, memMean: 0, memMax: 0, nMax: 0, sub: new Map() }
      t.cpuMean += a.cpuMean * f.res; t.memMean += a.memMean * f.res
      t.cpuMax = Math.max(t.cpuMax, a.cpuMax); t.memMax = Math.max(t.memMax, a.memMax); t.nMax = Math.max(t.nMax, a.n)
      for (const [s, v] of a.sub) t.sub.set(s, (t.sub.get(s) ?? 0) + v * f.res)
      acc.set(k, t)
    }
  }
  return [...acc.values()].map(t => ({
    key: t.key, cpuMean: r1(t.cpuMean / span), cpuMax: r1(t.cpuMax), cpuSec: Math.round(t.cpuMean / 100),
    memMeanMb: Math.round(t.memMean / span), memMaxMb: Math.round(t.memMax), nMax: t.nMax,
    top: [...t.sub.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(e => e[0]),
  }))
}

// Contiguous frames where the machine crossed a threshold, with who was busiest during each episode.
function spikes(frames, { cpu = 85, mem = 90, labelOf = x => x, gapSec = 180 } = {}) {
  const hot = frames.filter(f => (f.m.cpu?.[1] ?? 0) >= cpu || (f.m.usedPct?.[1] ?? 0) >= mem)
  const episodes = []
  for (const f of hot) {
    const last = episodes[episodes.length - 1]
    if (last && f.t - last.end <= gapSec * 1000) { last.frames.push(f); last.end = f.t + f.res * 1000 } else episodes.push({ start: f.t, end: f.t + f.res * 1000, frames: [f] })
  }
  return episodes.map(e => ({
    start: new Date(e.start).toISOString(), end: new Date(e.end).toISOString(), minutes: r1((e.end - e.start) / 60000),
    peakCpu: Math.max(...e.frames.map(f => f.m.cpu?.[1] ?? 0)), peakUsedPct: Math.max(...e.frames.map(f => f.m.usedPct?.[1] ?? 0)),
    topCpu: top(e.frames, { by: 'both', labelOf }).sort((a, b) => b.cpuMean - a.cpuMean).slice(0, 5).map(r => ({ key: r.key, cpuMean: r.cpuMean, cpuMax: r.cpuMax })),
    topMem: top(e.frames, { by: 'both', labelOf }).sort((a, b) => b.memMaxMb - a.memMaxMb).slice(0, 5).map(r => ({ key: r.key, memMaxMb: r.memMaxMb })),
  }))
}

// Known waste patterns, each with the evidence that names it.
function patterns(frames, { labelOf = x => x } = {}) {
  const found = []
  const span = frames.reduce((s, f) => s + f.res, 0)
  if (!span) return found
  const grepTicks = frames.filter(f => f.g.some(r => r[1] === 'grep' && r[7] >= 5))
  if (grepTicks.length) {
    const peak = Math.max(...grepTicks.flatMap(f => f.g.filter(r => r[1] === 'grep').map(r => r[7])))
    found.push({ pattern: 'grep-storm', ticks: grepTicks.length, evidence: `${peak} grep/rg/find processes alive at once`, fix: 'Search tools (Grep/Glob, git grep), never recursive grep over worktrees or node_modules; kill leftover greps (mem-map -Kill orphans).' })
  }
  const tscDup = frames.filter(f => f.g.filter(r => r[1] === 'tsc').reduce((s, r) => s + r[7], 0) >= 2)
  if (tscDup.length) found.push({ pattern: 'duplicate-typecheck', ticks: tscDup.length, evidence: `2+ typecheck processes at once in ${tscDup.length} ticks`, fix: 'Typecheck only through tc_run (one lane per slot).' })
  const builds = frames.filter(f => f.g.filter(r => r[1] === 'next-build').map(r => r[2]).filter((v, i, a) => a.indexOf(v) === i).length >= 2)
  if (builds.length) found.push({ pattern: 'parallel-builds', ticks: builds.length, evidence: `builds in 2+ worktrees at once in ${builds.length} ticks`, fix: 'Builds only inside heavy_acquire.' })
  const browsers = new Map()
  for (const f of frames) for (const r of f.g) if (r[1] === 'browser' || /chrome-headless-shell/i.test(r[0])) browsers.set(r[2], (browsers.get(r[2]) ?? 0) + f.res)
  for (const [wt, sec] of browsers) if (sec >= 1800) found.push({ pattern: 'long-lived-automation-browser', ticks: Math.round(sec / 60), evidence: `${labelOf(wt)} kept an automation browser for ${Math.round(sec / 60)} min`, fix: 'Close browsers when done; keep-browser marker only when the owner asked.' })
  const idleServers = new Map()
  for (const f of frames) for (const r of f.g) if (/next-(server|dev)/.test(r[1]) && r[3] < 0.5) idleServers.set(r[2], (idleServers.get(r[2]) ?? 0) + f.res)
  for (const [wt, sec] of idleServers) if (sec >= 3600) found.push({ pattern: 'idle-dev-server', ticks: Math.round(sec / 60), evidence: `${labelOf(wt)} kept an idle server for ${Math.round(sec / 60)} min`, fix: 'Stop servers after the test (server_wait, one at a time).' })
  // One process pinned near a full core tick after tick: a hung test, a runaway regex, an orphan nobody waits on.
  const pinned = new Map()
  for (const f of frames) for (const p of f.p ?? []) if (p[4] >= 90 && !/^(System|Registry|Memory Compression|vmmem.*|Secure System)$/i.test(p[1])) {
    const a = pinned.get(p[0]) ?? { pid: p[0], name: p[1], wt: p[3], ticks: 0, cmd: p[7] }
    a.ticks++
    pinned.set(p[0], a)
  }
  for (const a of pinned.values()) if (a.ticks >= 10) found.push({ pattern: 'stuck-busy-process', ticks: a.ticks, evidence: `pid ${a.pid} ${a.name} (${labelOf(a.wt)}) at 90%+ of a core for ${a.ticks} ticks: ${a.cmd.slice(0, 120)}`, fix: 'Ask its agent whether it is still wanted; a hung test or an orphan gets killed (mem-map -Kill orphans for orphans).' })
  const unacc = frames.reduce((s, f) => s + (f.m.unacc?.[0] ?? 0) * f.res, 0) / span
  if (unacc >= 50) found.push({ pattern: 'short-lived-process-churn', ticks: frames.length, evidence: `${r1(unacc)}% of a core on average went to processes that lived less than a tick (or interrupts)`, fix: 'Lower the interval for a while (perf.mjs install --interval 10) to catch them, then look for spawn loops (polling scripts, watch loops, hooks).' })
  return found
}

// Runs each snapshot attempt in order until one succeeds; every failure goes to onFail(index, error) first. Throws the
// last error when all fail. The collector passes a full snap, then a light one, so a paging machine still gets a tick.
async function firstSnap(attempts, onFail) {
  let last
  for (let i = 0; i < attempts.length; i++) {
    try { return { snap: await attempts[i](), attempt: i } } catch (e) { last = e; onFail?.(i, e) }
  }
  throw last ?? new Error('no snapshot attempt')
}

// Collector health from collector.log lines ("<iso> <message>") since fromMs: ticks lost (every attempt failed) and
// ticks saved by the light retry.
function tickHealth(logText, fromMs) {
  let lost = 0, recovered = 0, lastLostAt = null
  for (const line of String(logText).split('\n')) {
    const m = line.match(/^(\d{4}-\d\d-\d\dT[\d:.]+Z) (.*)$/)
    if (!m || Date.parse(m[1]) < fromMs) continue
    if (m[2].startsWith('tick: ')) { lost++; lastLostAt = m[1] } else if (m[2].startsWith('snap: light retry ok')) recovered++
  }
  return { lost, recovered, lastLostAt }
}

export {
  firstSnap, tickHealth, parseSnap, parsePs, psTimeTo100ns, cpuPct, machineCpuPct, filetimeToMs, kindOf, worktreeOf, repoRootOf, buildParents,
  appRootOf, attribute, redactCmd, buildTick, tickToFrame, rollup, expired, localDay, top, spikes, patterns, MACHINE_FIELDS,
}
