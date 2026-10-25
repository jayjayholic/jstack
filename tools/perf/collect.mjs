#!/usr/bin/env node
// The collector: one tick every intervalSec (config.json, default 60). Each tick takes one snapshot of every process
// (perf-snap.exe on Windows, ps elsewhere), turns CPU counters into % of one core over the interval, attributes each
// process to a worktree/agent (cwd, repo root, command line, ancestors; agent names from mem-map.ps1 -Agents),
// redacts command lines, and appends one JSON line to raw/<day>.jsonl. Past days are compressed and rolled up.
// Single instance: a second start exits while the first is alive, so the scheduled task can fire it every few minutes.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseSnap, parsePs, buildParents, attribute, buildTick, localDay, redactCmd } from './lib.mjs'
import { storeDir, loadConfig, appendTick, finalizeDays, loadAgents, saveAgents } from './store.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DIR = storeDir()
const IS_WIN = process.platform === 'win32'

function log(msg) {
  const file = path.join(DIR, 'collector.log')
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 1048576) fs.renameSync(file, `${file}.1`)
    fs.appendFileSync(file, `${new Date().toISOString()} ${msg}\n`)
  } catch { /* logging never stops the collector */ }
}

function alive(pid) { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }

function claimInstance(intervalSec) {
  fs.mkdirSync(DIR, { recursive: true })
  const file = path.join(DIR, 'collector.pid')
  try {
    const pid = +fs.readFileSync(file, 'utf8').trim()
    const fresh = Date.now() - fs.statSync(file).mtimeMs < Math.max(180, intervalSec * 3) * 1000
    if (pid && pid !== process.pid && alive(pid) && fresh) return false
  } catch { /* no pid file yet */ }
  fs.writeFileSync(file, String(process.pid))
  return true
}

function snapExe() { return process.env.JSTACK_PERF_SNAP || path.join(DIR, 'bin', 'perf-snap.exe') }

function snapshotWindows(knownKeys) {
  return new Promise((resolve, reject) => {
    const child = spawn(snapExe(), ['snap'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const chunks = []
    let err = ''
    const timer = setTimeout(() => child.kill(), 30000)
    child.stdout.on('data', c => chunks.push(c))
    child.stderr.on('data', c => { err += c })
    child.on('error', reject)
    child.on('close', code => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(`perf-snap exited ${code}: ${err.trim()}`))
      resolve(parseSnap(Buffer.concat(chunks).toString('utf8')))
    })
    child.stdin.end([...knownKeys].join('\n'))
  })
}

// UNVERIFIED outside Windows: written against the ps(1) man pages for macOS and procps, never run here.
function snapshotPosix(knownKeys) {
  const t0 = process.cpuUsage()
  const ps = spawnSync('ps', ['-axww', '-o', 'pid=,ppid=,rss=,time=,comm='], { encoding: 'utf8' })
  const procs = parsePs(ps.stdout || '')
  const details = new Map()
  const fresh = procs.filter(p => !knownKeys.has(`${p.pid}:${p.create}`))
  if (fresh.length) {
    const args = spawnSync('ps', ['-ww', '-o', 'pid=,args=', '-p', fresh.map(p => p.pid).join(',')], { encoding: 'utf8' })
    const cmd = new Map((args.stdout || '').split('\n').map(l => l.match(/^\s*(\d+)\s+(.*)$/)).filter(Boolean).map(m => [+m[1], m[2]]))
    for (const p of fresh) {
      let cwd = ''
      try { if (process.platform === 'linux') cwd = fs.readlinkSync(`/proc/${p.pid}/cwd`) } catch { /* not ours */ }
      details.set(`${p.pid}:${p.create}`, { cwd, cmd: cmd.get(p.pid) ?? '' })
    }
  }
  const cpus = os.cpus()
  const sum = k => cpus.reduce((s, c) => s + c.times[k], 0) * 1e4
  const idle = sum('idle')
  const machine = {
    idle, kernel: sum('sys') + sum('irq') + idle, user: sum('user') + sum('nice'), totalPhys: os.totalmem(), availPhys: os.freemem(),
    commit: 0, commitLimit: 0, cache: 0, paged: 0, nonpaged: 0, pfTotal: 0, pfUsed: 0, diskQueue: 0, disks: 0, diskIdle: 0, diskQuery: 0,
    diskRead: 0, diskWrite: 0, procCount: procs.length, cores: cpus.length,
  }
  const u = process.cpuUsage(t0)
  return { machine, procs, details, self: { cpu100ns: (u.user + u.system) * 10, peakWs: 0, priv: 0 } }
}

function lockDirs(cfg) {
  const dirs = [...(cfg.lockDirs ?? [])]
  if (!dirs.length) {
    const base = process.env.JSTACK_LOCK_DIR || path.join(os.homedir(), '.jstack', 'heavy-lock')
    dirs.push(base, `${base}-tc-1`, `${base}-tc-2`)
  }
  return dirs
}

// [[slot, owner, ageMin, worktree]] for every held slot, from the owner line heavy-lock.sh writes: "<owner> <date> @ <path>".
function readLocks(dirs, now = Date.now()) {
  const out = []
  for (const d of dirs) {
    const own = path.join(d, 'owner')
    try {
      const raw = fs.readFileSync(own, 'utf8').trim()
      const at = raw.match(/@\s+(\S.*)$/)
      out.push([path.basename(d), raw.split(/\s/)[0], Math.round((now - fs.statSync(own).mtimeMs) / 60000), at ? at[1].trim().replace(/\//g, '\\').replace(/\\+$/, '') : ''])
    } catch { /* free slot */ }
  }
  return out
}

// Worktree -> { branch, agent } through mem-map.ps1 -Agents, so labels match the memory map. At most one call every
// 5 minutes, only for worktrees not resolved in the last 30 minutes, never blocking a tick.
let agentsBusy = false
let agentsLastRun = 0
function refreshAgents(cfg, seenWts) {
  if (!IS_WIN || agentsBusy || Date.now() - agentsLastRun < 300000) return
  const memMap = cfg.memMap || path.join(HERE, '..', 'mem-map.ps1')
  if (!fs.existsSync(memMap)) return
  const agents = loadAgents(DIR)
  const due = [...seenWts].filter(w => !w.startsWith('app:') && w !== '_small' && (!agents[w] || Date.now() - Date.parse(agents[w].at) > 1800000))
  if (!due.length) return
  agentsBusy = true
  agentsLastRun = Date.now()
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', memMap, '-Agents', due.join(';')]
  if (cfg.lockDirs?.length) args.push('-LockDirs', cfg.lockDirs.join(';'))
  if (cfg.queueFile) args.push('-QueueFile', cfg.queueFile)
  const child = spawn('powershell.exe', args, { windowsHide: true })
  let out = ''
  child.stdout.on('data', c => { out += c })
  child.on('close', () => {
    agentsBusy = false
    try {
      const rows = JSON.parse(out.trim() || '[]')
      const map = loadAgents(DIR)
      for (const r of Array.isArray(rows) ? rows : [rows]) if (r?.worktree) map[r.worktree] = { branch: r.branch ?? '', agent: r.agent ?? '', at: new Date().toISOString() }
      saveAgents(map, DIR)
    } catch (e) { log(`agents: ${e.message}`) }
  })
  child.on('error', e => { agentsBusy = false; log(`agents: ${e.message}`) })
}

async function main() {
  let cfg = loadConfig(DIR)
  if (!claimInstance(cfg.intervalSec)) return
  log(`collector start pid ${process.pid} every ${cfg.intervalSec}s`)
  if (IS_WIN && !fs.existsSync(snapExe())) { log(`missing ${snapExe()}: run perf.mjs install`); process.exit(1) }
  try { finalizeDays(Date.now(), DIR, cfg) } catch (e) { log(`finalize: ${e.message}`) }
  let state = null
  let details = new Map()
  let day = localDay(Date.now())
  let cpu0 = process.cpuUsage()
  let wall0 = Date.now()
  const pidFile = path.join(DIR, 'collector.pid')
  const tick = async () => {
    const started = Date.now()
    try {
      if (+fs.readFileSync(pidFile, 'utf8').trim() !== process.pid) { log('another collector took over; exiting'); process.exit(0) }
      const snap = IS_WIN ? await snapshotWindows(new Set(details.keys())) : snapshotPosix(new Set(details.keys()))
      const at = Date.now()
      const live = new Map()
      for (const p of snap.procs) {
        const key = `${p.pid}:${p.create}`
        const d = snap.details.get(key) ?? details.get(key)
        if (d) live.set(key, d.redacted ? d : { cwd: d.cwd, cmd: redactCmd(d.cmd, 400), redacted: true })
      }
      details = live
      const procs = attribute(snap.procs, details, buildParents(snap.procs))
      const me = snap.procs.find(p => p.pid === process.pid)
      const u = process.cpuUsage(cpu0)
      const wall = (at - wall0) / 1000
      cpu0 = process.cpuUsage(); wall0 = at
      const self = state ? {
        cpu: Math.round(((u.user + u.system) / 1e4 / wall) * 100) / 100,
        rssMb: Math.round(process.memoryUsage().rss / 1048576), privMb: me ? Math.round(me.priv / 1048576) : null,
        snapCpuMs: snap.self ? Math.round(snap.self.cpu100ns / 1e4) : null, snapPeakMb: snap.self?.peakWs ? Math.round(snap.self.peakWs / 1048576) : null,
        tickMs: at - started,
      } : null
      const { record, state: next } = buildTick(state, null, { at, procs, machine: snap.machine, locks: readLocks(lockDirs(cfg), at), self })
      if (state) appendTick(record, DIR)
      state = next
      fs.utimesSync(pidFile, new Date(), new Date())
      refreshAgents(cfg, new Set(procs.map(p => p.wt)))
      const today = localDay(at)
      if (today !== day) { day = today; finalizeDays(at, DIR, cfg); cfg = loadConfig(DIR) }
    } catch (e) { log(`tick: ${e.stack || e.message}`) }
    const wait = cfg.intervalSec * 1000 - (Date.now() - started)
    setTimeout(tick, Math.max(1000, wait))
  }
  const stop = () => { try { if (+fs.readFileSync(pidFile, 'utf8') === process.pid) fs.rmSync(pidFile) } catch { /* gone */ } process.exit(0) }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  await tick()
}

main()
