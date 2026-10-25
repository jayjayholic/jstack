// The autonomous side of the monitor: the warden's memory (actions, notices, triggers), the floor, the optimizer
// lock that keeps at most one optimizer agent running, the idempotent `ensure`, and Windows Search exclusions.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { readLines, readFrames, storeDir, loadConfig } from './store.mjs'

const DIR = () => storeDir()
const iso = ms => new Date(ms).toISOString()

function since(args, dflt) {
  const v = String(args.since ?? dflt)
  const m = v.match(/^(\d+)(m|h|d)$/)
  return m ? Date.now() - +m[1] * { m: 6e4, h: 3.6e6, d: 8.64e7 }[m[2]] : Date.parse(v)
}

function readLog(name, fromMs) { return readLines(path.join(DIR(), name)).filter(r => Date.parse(r.at) >= fromMs) }

function cmdActions(args) {
  const rows = readLog('actions.jsonl', since(args, '24h'))
  if (args.json) return console.log(JSON.stringify(rows, null, 1))
  const counts = {}
  for (const r of rows) counts[`${r.action}${r.mode === 'act' ? '' : ` (${r.mode})`}`] = (counts[`${r.action}${r.mode === 'act' ? '' : ` (${r.mode})`}`] ?? 0) + 1
  console.log(Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(', ') || 'no actions')
  for (const r of rows.slice(-+(args.limit ?? 30))) {
    const t = r.target ? (typeof r.target === 'string' ? r.target : `${r.target.name ?? ''} ${r.target.pid ?? ''} ${r.target.wt ?? ''}`) : ''
    const delta = r.delta ? ` -> available ${r.delta.availMb >= 0 ? '+' : ''}${r.delta.availMb} MB` : ''
    console.log(`${r.at.slice(0, 19)} ${r.action}${r.mode === 'act' ? '' : `(${r.mode})`} ${t.trim()} ${r.why ?? ''}${delta}`.trim())
  }
}

function cmdNotices(args) {
  const rows = readLog('notices.jsonl', since(args, '24h'))
  if (args.json) return console.log(JSON.stringify(rows, null, 1))
  for (const r of rows) console.log(`${r.at.slice(0, 19)} ${r.type} pid ${r.pid} ${r.name} ${r.wt} ${r.minutes} min: ${r.cmd}`)
  if (!rows.length) console.log('no notices')
}

// ---------- the optimizer lock: one agent at a time, spawned on a trigger or every 30 min ----------

const STATE = () => path.join(DIR(), 'optimizer.json')
function optState() { try { return JSON.parse(fs.readFileSync(STATE(), 'utf8')) } catch { return {} } }
function saveOpt(s) { fs.mkdirSync(DIR(), { recursive: true }); fs.writeFileSync(STATE(), JSON.stringify(s, null, 1)) }

function optimizerDue(now = Date.now(), { everyMin = 30, staleMin = 90 } = {}) {
  const s = optState()
  if (s.runningSince && now - Date.parse(s.runningSince) < staleMin * 60000) return { due: false, reason: `an optimizer run started ${s.runningSince} is still open` }
  const last = s.lastFinishedAt ? Date.parse(s.lastFinishedAt) : 0
  const pending = readLines(path.join(DIR(), 'triggers.jsonl')).filter(t => Date.parse(t.at) > last)
  if (pending.length) return { due: true, reason: `${pending.length} trigger(s) since the last run`, pending }
  if (now - last >= everyMin * 60000) return { due: true, reason: last ? `last run ${Math.round((now - last) / 60000)} min ago` : 'never ran', pending }
  return { due: false, reason: `last run ${Math.round((now - last) / 60000)} min ago, no trigger` }
}

function cmdOptimizer(args) {
  const sub = args._[1] ?? 'due'
  if (sub === 'due') {
    const d = optimizerDue(Date.now(), { everyMin: +(args.every ?? 30) })
    console.log(JSON.stringify({ due: d.due, reason: d.reason, pending: (d.pending ?? []).slice(-20) }))
    process.exitCode = d.due ? 0 : 1
    return
  }
  if (sub === 'start') {
    const d = optimizerDue(Date.now(), { everyMin: 0 })
    if (!d.due && !args.force) { console.log(JSON.stringify({ started: false, reason: d.reason })); process.exitCode = 1; return }
    saveOpt({ ...optState(), runningSince: iso(Date.now()) })
    console.log(JSON.stringify({ started: true, pending: d.pending ?? [] }))
    return
  }
  if (sub === 'finish') {
    const s = optState()
    saveOpt({ lastFinishedAt: iso(Date.now()), lastStartedAt: s.runningSince ?? null, lastSummary: args.summary && args.summary !== true ? String(args.summary).slice(0, 500) : '' })
    fs.appendFileSync(path.join(DIR(), 'actions.jsonl'), `${JSON.stringify({ at: iso(Date.now()), mode: 'act', action: 'optimizer-run', why: args.summary && args.summary !== true ? String(args.summary).slice(0, 500) : '', startedAt: s.runningSince ?? null })}\n`)
    console.log('finished')
    return
  }
  throw new Error('optimizer due|start|finish [--summary text]')
}

// ---------- the floor: what the machine costs with the agents' legitimate work running ----------

function pct(xs, q) { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))] : null }

// 15-minute windows where agent work was running (a worktree process using 5%+ of a core); the floor is their p25.
function computeFloor(frames) {
  const windows = []
  for (let i = 0; i + 15 <= frames.length; i += 5) {
    const w = frames.slice(i, i + 15)
    const active = w.filter(f => f.g.some(r => !String(r[2]).startsWith('app:') && r[2] !== '_small' && r[3] >= 5)).length
    if (active < 10) continue
    windows.push({ cpu: w.reduce((s, f) => s + (f.m.cpu?.[0] ?? 0), 0) / w.length, used: w.reduce((s, f) => s + (f.m.usedPct?.[0] ?? 0), 0) / w.length })
  }
  const r1 = v => (v == null ? null : Math.round(v * 10) / 10)
  const q = key => ({ p25: r1(pct(windows.map(w => w[key]), 0.25)), p50: r1(pct(windows.map(w => w[key]), 0.5)), p75: r1(pct(windows.map(w => w[key]), 0.75)) })
  return { windows: windows.length, cpu: q('cpu'), used: q('used') }
}

function cmdFloor(args) {
  const from = since(args, '24h')
  const frames = readFrames(from, Date.now(), DIR())
  const f = { at: iso(Date.now()), since: iso(from), ...computeFloor(frames) }
  const last = frames.slice(-15)
  f.now = { cpu: last.length ? Math.round(last.reduce((s, x) => s + (x.m.cpu?.[0] ?? 0), 0) / last.length * 10) / 10 : null, used: last.length ? Math.round(last.reduce((s, x) => s + (x.m.usedPct?.[0] ?? 0), 0) / last.length * 10) / 10 : null }
  f.aboveFloor = { cpu: f.cpu.p25 == null || f.now.cpu == null ? null : Math.round((f.now.cpu - f.cpu.p25) * 10) / 10, used: f.used.p25 == null || f.now.used == null ? null : Math.round((f.now.used - f.used.p25) * 10) / 10 }
  if (args.write && f.windows) fs.writeFileSync(path.join(DIR(), 'floor.json'), JSON.stringify(f, null, 1))
  console.log(JSON.stringify(f, null, 1))
}

// ---------- ensure: one idempotent line for the train ----------

function collectorAlive() {
  try {
    const file = path.join(DIR(), 'collector.pid')
    const pid = +fs.readFileSync(file, 'utf8').trim()
    process.kill(pid, 0)
    return Date.now() - fs.statSync(file).mtimeMs < 180000 ? pid : null
  } catch { return null }
}

function cmdEnsure(args, install) {
  const pid = collectorAlive()
  if (pid) return console.log(`perf: collector + warden running (pid ${pid})`)
  const cfg = loadConfig(DIR())
  if (process.platform === 'win32' && fs.existsSync(path.join(DIR(), 'app', 'launch.vbs')) && !args.reinstall) {
    const r = spawnSync('schtasks', ['/Run', '/TN', cfg.taskName], { encoding: 'utf8', windowsHide: true })
    return console.log(r.status === 0 ? `perf: started task ${cfg.taskName}` : `perf: task ${cfg.taskName} missing, run perf.mjs install`)
  }
  install(args)
}

// ---------- Windows Search: exclude dev roots from indexing ----------

function defaultSearchRoots() {
  const h = os.homedir()
  const la = process.env.LOCALAPPDATA || path.join(h, 'AppData', 'Local')
  const ra = process.env.APPDATA || path.join(h, 'AppData', 'Roaming')
  return ['C:\\dev', path.join(h, '.claude'), path.join(h, '.jstack'), path.join(h, '.bun'), path.join(h, '.cache'), path.join(la, 'npm-cache'), path.join(ra, 'npm'), path.join(la, 'pnpm'), path.join(la, 'Yarn'), path.join(la, 'ms-playwright')]
}

function cmdSearchExclude(args) {
  if (process.platform !== 'win32') throw new Error('Windows only')
  const exe = path.join(DIR(), 'bin', 'search-scope.exe')
  if (!fs.existsSync(exe)) throw new Error('search-scope.exe missing: run perf.mjs install')
  const extra = args.add && args.add !== true ? String(args.add).split(';').filter(Boolean) : []
  const roots = [...new Set([...defaultSearchRoots(), ...extra])].filter(p => fs.existsSync(p))
  const before = spawnSync(exe, ['check', ...roots], { encoding: 'utf8', windowsHide: true }).stdout.trim().split(/\r?\n/)
  const todo = before.filter(l => l.startsWith('included ')).map(l => l.slice(9))
  if (args['dry-run'] || !todo.length) return console.log(JSON.stringify({ alreadyExcluded: before.filter(l => l.startsWith('excluded ')).map(l => l.slice(9)), toExclude: todo }, null, 1))
  const r = spawnSync(exe, ['exclude', ...todo], { encoding: 'utf8', windowsHide: true })
  const rec = { at: iso(Date.now()), mode: 'act', action: 'search-exclude', target: todo, ok: r.status === 0, why: 'dev roots out of Windows Search indexing (owner-approved one-time change)', undo: `search-scope.exe include ${todo.map(t => `"${t}"`).join(' ')}` }
  if (r.status === 5) {
    const cmd = path.join(DIR(), 'app', 'search-exclude-admin.cmd')
    fs.writeFileSync(cmd, `@echo off\r\npowershell -NoProfile -Command "Start-Process '${exe}' -ArgumentList 'exclude ${todo.map(t => `\\"${t}\\"`).join(' ')}' -Verb RunAs"\r\n`)
    rec.why += `; needs admin: run ${cmd}`
  }
  fs.appendFileSync(path.join(DIR(), 'actions.jsonl'), `${JSON.stringify(rec)}\n`)
  console.log(JSON.stringify(rec, null, 1))
}

export { cmdActions, cmdNotices, cmdOptimizer, cmdFloor, cmdEnsure, cmdSearchExclude, optimizerDue, computeFloor, defaultSearchRoots }
