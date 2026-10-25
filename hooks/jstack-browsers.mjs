// jstack browser cleanup: closes the Playwright/automation browsers an agent leaves open.
// Used by jstack-guards.mjs (cleanup on SubagentStop/Stop) and its CLI modes `keep-browser` and `browser-watch`.
// Opt-in per project: "browsers": { "enabled": true }. Ownership comes from jstack-calls.mjs: a browser belongs to
// the agent whose tool call started the shell it descends from; a browser whose launcher died is an orphan.
//
// Never touched: a browser without a debugging pipe/port (the owner's own Chrome, the Claude in Chrome extension),
// a browser on a default Chrome/Edge/Chromium profile, a browser another agent owns or that can't be attributed,
// and a browser with a keep marker (~/.jstack/keep-browser/<pid>, pid of the browser or its launcher, 1 h).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import * as calls from './jstack-calls.mjs'

const WIN = process.platform === 'win32'
const BROWSER_EXE = /^(?:chrome|chromium|headless_shell|chrome-headless-shell|msedge)(?:\.exe)?$/i
const DEFAULT_PROFILE = /\/(?:google\/chrome(?: beta| dev| sxs| canary)?|chromium|microsoft\/edge(?: beta| dev| sxs)?)\/user data$|\/\.config\/(?:google-chrome(?:-beta|-unstable)?|chromium|microsoft-edge)$|\/library\/application support\/(?:google\/chrome|chromium|microsoft edge)$/i
const AUTOMATION_PROFILE = /ms-playwright|playwright|puppeteer/i
const KEEP_MS = 3600_000
const GRACE_MS = 600_000

function keepDir(env = process.env) { return path.join(calls.jstackHome(env), 'keep-browser') }
function slash(p) { return String(p).replace(/\\/g, '/').replace(/\/+$/, '') }

function userDataDir(cmd) {
  const m = /--user-data-dir=(?:"([^"]+)"|(\S+))/.exec(cmd)
  return m ? m[1] ?? m[2] : null
}

function isAutomationBrowser(p, extraProfiles = []) {
  if (!BROWSER_EXE.test(String(p.n || ''))) return false
  const c = String(p.c || '')
  if (/\s--type=/.test(c) || !/--remote-debugging-(?:pipe|port)/.test(c)) return false
  const dir = userDataDir(c)
  if (!dir) return false
  const d = slash(dir)
  if (DEFAULT_PROFILE.test(d)) return false
  const extra = extraProfiles.map(x => slash(x.replace(/^~(?=\/|\\|$)/, os.homedir())).toLowerCase())
  return /--enable-automation/.test(c) || AUTOMATION_PROFILE.test(d) || extra.includes(d.toLowerCase())
}

function findBrowsers(procs, extraProfiles = []) {
  const { byPid } = calls.indexProcs(procs)
  return procs.filter(p => isAutomationBrowser(p, extraProfiles)).map(p => {
    const chainPids = []
    for (let cur = p, i = 0; cur && i < 60 && !/^claude(?:\.exe)?$/i.test(String(cur.n || '')); i++) {
      chainPids.push(cur.p)
      const parent = byPid.get(cur.pp)
      cur = parent && !(parent.t && cur.t && parent.t > cur.t + 1000) ? parent : null
    }
    return { pid: p.p, t: p.t, name: p.n, cmd: String(p.c), profile: userDataDir(String(p.c)), claudePid: calls.chainOf(p.p, byPid).claude?.p ?? null, chainPids }
  })
}

// ---------- keep markers ----------

function keptPids(env = process.env, now = Date.now(), keepMs = KEEP_MS) {
  const pids = new Set()
  let files = []
  try { files = fs.readdirSync(keepDir(env)) } catch { return pids }
  for (const f of files) {
    const file = path.join(keepDir(env), f)
    try {
      if (now - fs.statSync(file).mtimeMs > keepMs) { fs.unlinkSync(file); continue }
      const pid = parseInt(f, 10)
      if (pid > 0) pids.add(pid)
    } catch {}
  }
  return pids
}

function isKept(b, kept) { return b.chainPids.some(p => kept.has(p)) }

function writeKeep(pids, reason, env = process.env) {
  fs.mkdirSync(keepDir(env), { recursive: true })
  for (const p of pids) fs.writeFileSync(path.join(keepDir(env), String(p)), JSON.stringify({ at: new Date().toISOString(), reason: reason ?? '' }))
}

function dropKeep(pids, env = process.env) {
  for (const p of pids) { try { fs.unlinkSync(path.join(keepDir(env), String(p))) } catch {} }
}

// ---------- closing ----------

function alive(pid) { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

// CDP Browser.close for browsers on a debugging port (the port is on the command line, or in DevToolsActivePort
// when it was 0). Pipe browsers, Playwright's default, have no outside channel; they get WM_CLOSE/SIGTERM only.
const CDP_CLOSE = `const port = process.argv[1]
fetch('http://127.0.0.1:' + port + '/json/version').then(r => r.json()).then(v => {
  const ws = new WebSocket(v.webSocketDebuggerUrl)
  ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
  ws.onmessage = () => process.exit(0)
  ws.onclose = () => process.exit(0)
}).catch(() => process.exit(1))
setTimeout(() => process.exit(1), 3000)`

function debugPort(cmd, profile) {
  const m = /--remote-debugging-port=(\d+)/.exec(cmd ?? '')
  if (!m) return null
  if (Number(m[1]) > 0) return Number(m[1])
  try { return Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]) || null } catch { return null }
}

// Graceful first (CDP close, then WM_CLOSE on Windows / SIGTERM elsewhere), then the whole tree by force after waitMs.
// targets: [{ pid, cmd, profile }] or plain pids.
function closeBrowsers(targets, waitMs = 5000) {
  const list = targets.map(t => (typeof t === 'number' ? { pid: t } : t))
  const pids = list.map(t => t.pid)
  const res = new Map()
  for (const t of list) {
    const port = debugPort(t.cmd, t.profile)
    if (port) spawnSync(process.execPath, ['-e', CDP_CLOSE, String(port)], { stdio: 'ignore', timeout: 5000 })
    if (!alive(t.pid)) continue
    if (WIN) spawnSync('taskkill', ['/PID', String(t.pid)], { stdio: 'ignore', timeout: 10000 })
    else { try { process.kill(t.pid, 'SIGTERM') } catch {} }
  }
  for (let t = 0; t < waitMs && pids.some(alive); t += 250) sleep(250)
  for (const pid of pids) {
    if (!alive(pid)) { res.set(pid, 'graceful'); continue }
    if (WIN) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 10000 })
    else {
      // UNVERIFIED on Linux/macOS: kills the browser's process group, which Playwright creates per launch.
      try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch {} }
    }
    res.set(pid, 'killed')
  }
  return res
}

// ---------- entry points ----------

function browsersConf(project) { return project?.browsers?.enabled === true ? project.browsers : null }

// Closes the automation browsers the stopping agent owns. ctx: { procs, isMine(pid), log(entry), closeBrowsers? }.
function onStop(project, payload, ctx, env = process.env, now = Date.now()) {
  const conf = browsersConf(project)
  if (!conf) return { closed: [], kept: [] }
  const mine = findBrowsers(ctx.procs, conf.profiles).filter(b => ctx.isMine(b.pid))
  if (!mine.length) return { closed: [], kept: [] }
  const kept = keptPids(env, now, (conf.keepMinutes ?? 60) * 60_000)
  const keep = mine.filter(b => isKept(b, kept))
  const close = mine.filter(b => !isKept(b, kept))
  const how = close.length ? (ctx.closeBrowsers ?? closeBrowsers)(close.map(b => ({ pid: b.pid, cmd: b.cmd, profile: b.profile }))) : new Map()
  for (const b of keep) ctx.log({ type: 'browser-kept', pid: b.pid, profile: b.profile })
  for (const b of close) ctx.log({ type: 'browser-close', reason: payload.hook_event_name, pid: b.pid, name: b.name, profile: b.profile, how: how.get(b.pid) })
  return { closed: close.map(b => b.pid), kept: keep.map(b => b.pid) }
}

// One watcher tick. Eligible: orphans (no claude ancestor: launcher or session gone) and browsers whose owning agent
// has stopped. Each must stay eligible for graceMs before it is closed. `seen` maps "pid:start" to the first
// eligible time.
function sweep({ procs, records, kept, seen, now = Date.now(), graceMs = GRACE_MS, profiles = [] }) {
  const due = [], waiting = []
  const live = new Set()
  const owners = calls.ownersOf(procs, records, now)
  for (const b of findBrowsers(procs, profiles)) {
    if (isKept(b, kept)) continue
    const orphan = !b.claudePid
    const r = orphan ? null : owners.get(b.pid)?.r
    if (!orphan && !r?.stoppedAt) continue
    const key = `${b.pid}:${b.t}`
    live.add(key)
    seen[key] ??= now
    if (now - seen[key] >= graceMs) due.push({ ...b, why: orphan ? 'orphan' : 'agent-stopped', agent: r?.agent ?? null, session: r?.session ?? null })
    else waiting.push(b)
  }
  for (const k of Object.keys(seen)) if (!live.has(k)) delete seen[k]
  return { due, waiting }
}

export { KEEP_MS, GRACE_MS, isAutomationBrowser, findBrowsers, keptPids, isKept, writeKeep, dropKeep, closeBrowsers, onStop, sweep, browsersConf }
