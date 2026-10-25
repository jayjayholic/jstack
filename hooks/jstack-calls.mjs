// jstack call ownership: which agent's tool call started a process.
// Subagents share one claude process, so the process tree alone only names the session. Every Bash/PowerShell call
// is recorded here (PreToolUse opens a window, PostToolUse closes it) with a fingerprint of its command. Claude starts
// one shell per call as a direct child of claude, and a Bash shell's command line carries the command text, so a
// shell is owned by the agent whose call window contains the shell's start AND whose command text it carries
// (PowerShell/cmd shells carry no text: closest call start wins, two calls within a second = nobody's).
// Everything a shell started is then owned by that agent. Unknown or ambiguous means nobody's: never killed.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CLAUDE_EXE = /^claude(?:\.exe)?$/i
const SHELL_EXE = /^(?:bash|sh|zsh|dash|powershell|pwsh|cmd)(?:\.exe)?$/i
const RECORD_TTL_MS = 86400_000
const MAX_WINDOWS = 200
const MAX_CALL_MS = 600_000
const FP_LEN = 400
const AMBIGUOUS_MS = 1000

function jstackHome(env = process.env) { return env.JSTACK_HOME || process.env.JSTACK_HOME || path.join(os.homedir(), '.jstack') }
function recordsDir(env = process.env) {
  const d = path.join(jstackHome(env), 'calls')
  fs.mkdirSync(d, { recursive: true })
  return d
}

function fingerprint(text) { return String(text ?? '').replace(/[^A-Za-z0-9]/g, '').toLowerCase() }

// ---------- records ----------

function recordKey(session, agent) { return `${session ?? 'nosession'}__${agent ?? 'main'}`.replace(/[^\w.-]/g, '-') }
function recordFile(payload, env) { return path.join(recordsDir(env), recordKey(payload.session_id, payload.agent_id) + '.json') }
function isRecordOf(r, payload) { return recordKey(r.session, r.agent) === recordKey(payload.session_id, payload.agent_id) }

function readRecord(payload, env = process.env) {
  try { return JSON.parse(fs.readFileSync(recordFile(payload, env), 'utf8')) } catch {
    return { session: payload.session_id ?? null, agent: payload.agent_id ?? 'main', agentType: payload.agent_type ?? null, claudePid: null, windows: [] }
  }
}
function writeRecord(payload, rec, env = process.env) { try { fs.writeFileSync(recordFile(payload, env), JSON.stringify(rec)) } catch {} }

function openWindow(payload, env = process.env, now = Date.now()) {
  const rec = readRecord(payload, env)
  if (env.CLAUDE_PID) rec.claudePid = Number(env.CLAUDE_PID)
  delete rec.stoppedAt
  const w = { s: now, bg: !!payload.tool_input?.run_in_background, fp: fingerprint(payload.tool_input?.command).slice(0, FP_LEN) }
  rec.windows = [...(rec.windows ?? []).filter(x => now - (x.e ?? x.s) < RECORD_TTL_MS), w].slice(-MAX_WINDOWS)
  writeRecord(payload, rec, env)
}

function closeWindow(payload, env = process.env, now = Date.now()) {
  const rec = readRecord(payload, env)
  const fp = fingerprint(payload.tool_input?.command).slice(0, FP_LEN)
  const open = (rec.windows ?? []).filter(x => x.e == null)
  const w = open.find(x => fp && x.fp === fp) ?? open[0]
  if (!w) return
  w.e = now
  writeRecord(payload, rec, env)
}

function markStopped(payload, env = process.env, now = Date.now(), claudePid = null) {
  const rec = readRecord(payload, env)
  if (claudePid) rec.claudePid = claudePid
  rec.stoppedAt = now
  writeRecord(payload, rec, env)
}

function readAllRecords(env = process.env, now = Date.now()) {
  const dir = recordsDir(env)
  const out = []
  for (const f of fs.readdirSync(dir)) {
    const file = path.join(dir, f)
    try {
      const r = JSON.parse(fs.readFileSync(file, 'utf8'))
      const last = Math.max(r.stoppedAt ?? 0, ...(r.windows ?? []).map(w => w.e ?? w.s))
      if (now - last > RECORD_TTL_MS) { fs.unlinkSync(file); continue }
      out.push(r)
    } catch {}
  }
  return out
}

// ---------- process tree ----------

function indexProcs(procs) {
  const byPid = new Map(procs.map(p => [p.p, p]))
  const children = new Map()
  for (const p of procs) { if (!children.has(p.pp)) children.set(p.pp, []); children.get(p.pp).push(p) }
  return { byPid, children }
}

// A parent that started after its child is a reused pid: the chain is broken there.
function parentOf(p, byPid) {
  const parent = byPid.get(p.pp)
  if (!parent || (parent.t && p.t && parent.t > p.t + 1000)) return null
  return parent
}

function isClaude(p) { return CLAUDE_EXE.test(String(p?.n || '')) && !/--chrome-native-host/.test(String(p?.c || '')) }

// Walks up to claude. Returns { claude, shell } (shell = the chain's direct child of claude) or nulls when broken.
function chainOf(pid, byPid) {
  let cur = byPid.get(pid), prev = null
  for (let i = 0; cur && i < 60; i++) {
    if (isClaude(cur)) return { claude: cur, shell: prev && SHELL_EXE.test(String(prev.n || '')) ? prev : null }
    prev = cur
    cur = parentOf(cur, byPid)
  }
  return { claude: null, shell: null }
}

function claudePidOf(pid, procs) { return chainOf(pid, indexProcs(procs).byPid).claude?.p ?? null }

function windowEnd(r, w, now) { return w.e ?? Math.min(r.stoppedAt ?? now, w.s + MAX_CALL_MS) }

function pickOne(hits) {
  if (!hits.length) return null
  hits.sort((a, b) => a.d - b.d)
  const rival = hits.find(h => h.r !== hits[0].r)
  return rival && rival.d - hits[0].d < AMBIGUOUS_MS ? null : hits[0].r
}

// The record whose call started this shell, or null.
function ownerOfShell(shell, records, now = Date.now(), claudePid = null) {
  const text = /\s-c\s/.test(String(shell.c || '')) && /^(?:bash|sh|zsh|dash)(?:\.exe)?$/i.test(String(shell.n || '')) ? fingerprint(shell.c) : null
  const hits = []
  for (const r of records) {
    if (claudePid && r.claudePid && r.claudePid !== claudePid) continue
    for (const w of r.windows ?? []) {
      if (!(shell.t >= w.s - 500 && shell.t <= windowEnd(r, w, now) + 500)) continue
      if (text != null && !(w.fp && w.fp.length >= 4 && text.includes(w.fp))) continue
      hits.push({ r, d: Math.abs(shell.t - w.s) })
    }
  }
  return pickOne(hits)
}

// The record whose call started this orphan (no claude ancestor), by its own start time; background calls stay
// open until the agent stops. Null when no call or more than one agent's call covers it.
function ownerOfOrphan(p, records, now = Date.now()) {
  const owners = new Set()
  let best = null
  for (const r of records) {
    for (const w of r.windows ?? []) {
      const end = w.bg ? r.stoppedAt ?? now : windowEnd(r, w, now)
      if (p.t >= w.s - 500 && p.t <= end + 2000) { owners.add(r); best = r }
    }
  }
  return owners.size === 1 ? best : null
}

// pid -> record for every live process: by its shell when the chain reaches claude, else (orphans) by start time.
function ownersOf(procs, records, now = Date.now()) {
  const { byPid } = indexProcs(procs)
  const shellOwner = new Map()
  const out = new Map()
  for (const p of procs) {
    const { claude, shell } = chainOf(p.p, byPid)
    if (claude) {
      if (!shell) continue
      if (!shellOwner.has(shell.p)) shellOwner.set(shell.p, ownerOfShell(shell, records, now, claude.p))
      const r = shellOwner.get(shell.p)
      if (r) out.set(p.p, { r, via: 'shell', shell: shell.p })
    } else {
      const r = ownerOfOrphan(p, records, now)
      if (r) out.set(p.p, { r, via: 'orphan' })
    }
  }
  return out
}

// Does the agent still have background work in flight? Stop/SubagentStop payloads carry background_tasks (the
// session's in-flight work); a local_bash task whose command matches one of this agent's background calls means the
// agent is paused waiting on it, not done. Without the field: any of its background shells still alive.
function hasLiveBackground(payload, rec, procs, records, now = Date.now()) {
  const bgFps = (rec.windows ?? []).filter(w => w.bg && w.fp).map(w => w.fp)
  if (!bgFps.length) return false
  if (Array.isArray(payload.background_tasks)) {
    return payload.background_tasks.some(t => {
      if (t?.type && !/bash|shell/i.test(String(t.type))) return false
      const a = fingerprint(t?.command ?? t?.description)
      if (a.length < 4) return false
      const n = Math.min(a.length, 120)
      return bgFps.some(b => b.slice(0, n) === a.slice(0, n))
    })
  }
  const owners = ownersOf(procs, records, now)
  return [...owners.values()].some(o => o.via === 'shell' && isRecordOf(o.r, payload))
}

export {
  fingerprint, jstackHome, recordKey, isRecordOf, readRecord, writeRecord, openWindow, closeWindow, markStopped, readAllRecords,
  indexProcs, chainOf, claudePidOf, ownerOfShell, ownerOfOrphan, ownersOf, hasLiveBackground, MAX_CALL_MS,
}
