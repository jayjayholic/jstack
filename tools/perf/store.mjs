// The monitor's store, outside every repo: <dir>/raw/<day>.jsonl (today, appended each tick) and .jsonl.gz (past
// days), 5m/<day>.jsonl.gz, 1h/<month>.jsonl, agents.json (worktree -> branch/agent from mem-map), ledger.jsonl
// (the optimize loop), config.json, collector.pid, collector.log. Default dir ~/.jstack/perf (JSTACK_PERF_DIR).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { tickToFrame, rollup, expired, localDay } from './lib.mjs'

const DEFAULT_CONFIG = { intervalSec: 60, rawDays: 14, fiveMinDays: 90, hourDays: 400, lockDirs: [], queueFile: '', memMap: '', taskName: 'JstackPerf' }

function storeDir() { return process.env.JSTACK_PERF_DIR || path.join(os.homedir(), '.jstack', 'perf') }

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback } }
function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1))
  fs.renameSync(tmp, file)
}

function loadConfig(dir = storeDir()) { return { ...DEFAULT_CONFIG, ...readJson(path.join(dir, 'config.json'), {}) } }
function saveConfig(cfg, dir = storeDir()) { fs.mkdirSync(dir, { recursive: true }); writeJsonAtomic(path.join(dir, 'config.json'), cfg) }

function appendTick(record, dir = storeDir()) {
  const raw = path.join(dir, 'raw')
  fs.mkdirSync(raw, { recursive: true })
  fs.appendFileSync(path.join(raw, `${localDay(Date.parse(record.t))}.jsonl`), `${JSON.stringify(record)}\n`)
}

function readLines(file) {
  if (!fs.existsSync(file)) return []
  const buf = fs.readFileSync(file)
  const text = file.endsWith('.gz') ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8')
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* a line cut by a crash mid-write */ }
  }
  return out
}

function firstExisting(...files) { return files.find(f => fs.existsSync(f)) }

// Frames covering [fromMs, toMs]: raw ticks where kept, else the 5-minute rollup, else the hourly one.
function readFrames(fromMs, toMs, dir = storeDir()) {
  const frames = []
  const months = new Set()
  for (let d = Date.parse(`${localDay(fromMs)}T00:00:00`); d <= toMs; d += 86400000) {
    const day = localDay(d)
    const raw = firstExisting(path.join(dir, 'raw', `${day}.jsonl`), path.join(dir, 'raw', `${day}.jsonl.gz`))
    if (raw) {
      for (const rec of readLines(raw)) if (rec.dt > 0) frames.push(tickToFrame(rec))
      // a day whose raw file was compressed while today's appends went to a fresh .jsonl
      if (raw.endsWith('.jsonl') && fs.existsSync(`${raw}.gz`)) for (const rec of readLines(`${raw}.gz`)) if (rec.dt > 0) frames.push(tickToFrame(rec))
      continue
    }
    const five = firstExisting(path.join(dir, '5m', `${day}.jsonl.gz`), path.join(dir, '5m', `${day}.jsonl`))
    if (five) { frames.push(...readLines(five)); continue }
    months.add(day.slice(0, 7))
  }
  for (const mo of months) frames.push(...readLines(path.join(dir, '1h', `${mo}.jsonl`)).filter(f => localDay(f.t).startsWith(mo)))
  return frames.filter(f => f.t + f.res * 1000 > fromMs && f.t <= toMs).sort((a, b) => a.t - b.t)
}

// Past days: compress the raw file, write its 5-minute and hourly rollups, then apply retention. Idempotent.
function finalizeDays(nowMs = Date.now(), dir = storeDir(), cfg = loadConfig(dir)) {
  const today = localDay(nowMs)
  const rawDir = path.join(dir, 'raw')
  const done = []
  for (const f of fs.existsSync(rawDir) ? fs.readdirSync(rawDir) : []) {
    const m = f.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/)
    if (!m || m[1] === today) continue
    const day = m[1]
    const file = path.join(rawDir, f)
    const recs = readLines(file).filter(r => r.dt > 0)
    const frames = recs.map(tickToFrame)
    fs.mkdirSync(path.join(dir, '5m'), { recursive: true })
    fs.mkdirSync(path.join(dir, '1h'), { recursive: true })
    const five = path.join(dir, '5m', `${day}.jsonl.gz`)
    fs.writeFileSync(five, zlib.gzipSync(rollup(frames, 300).map(r => JSON.stringify(r)).join('\n') + '\n'))
    const hourFile = path.join(dir, '1h', `${day.slice(0, 7)}.jsonl`)
    const keep = readLines(hourFile).filter(r => localDay(r.t) !== day)
    const hours = rollup(frames, 3600)
    fs.writeFileSync(hourFile, [...keep, ...hours].sort((a, b) => a.t - b.t).map(r => JSON.stringify(r)).join('\n') + '\n')
    const gz = `${file}.gz`
    const old = fs.existsSync(gz) ? zlib.gunzipSync(fs.readFileSync(gz)) : Buffer.alloc(0)
    fs.writeFileSync(gz, zlib.gzipSync(Buffer.concat([old, fs.readFileSync(file)])))
    fs.rmSync(file)
    done.push(day)
  }
  const all = []
  for (const sub of ['raw', '5m', '1h']) {
    const d = path.join(dir, sub)
    if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) all.push(`${sub}/${f}`)
  }
  const gone = expired(all, nowMs, { rawDays: cfg.rawDays, fiveMinDays: cfg.fiveMinDays, hourDays: cfg.hourDays })
  for (const f of gone) fs.rmSync(path.join(dir, f), { force: true })
  return { finalized: done, deleted: gone }
}

function loadAgents(dir = storeDir()) { return readJson(path.join(dir, 'agents.json'), {}) }
function saveAgents(map, dir = storeDir()) { fs.mkdirSync(dir, { recursive: true }); writeJsonAtomic(path.join(dir, 'agents.json'), map) }

// Label for a group's wt field: the agent name mem-map resolved, else the worktree folder, else the app root.
function labeler(agents) {
  return wt => {
    if (!wt || wt === '_small') return '(small processes)'
    if (wt.startsWith('app:')) return wt
    const a = agents[wt]
    if (a?.agent) return a.agent
    return `wt:${wt.split(/[\\/]/).pop()}`
  }
}

function appendLedger(entry, dir = storeDir()) {
  fs.mkdirSync(dir, { recursive: true })
  fs.appendFileSync(path.join(dir, 'ledger.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
}
function readLedger(dir = storeDir()) { return readLines(path.join(dir, 'ledger.jsonl')) }

function dirSizeMb(dir = storeDir()) {
  let bytes = 0
  const walk = d => { for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'app') walk(p) } else bytes += fs.statSync(p).size } }
  walk(dir)
  return Math.round(bytes / 1048576 * 10) / 10
}

export { storeDir, loadConfig, saveConfig, appendTick, readLines, readFrames, finalizeDays, loadAgents, saveAgents, labeler, appendLedger, readLedger, dirSizeMb, writeJsonAtomic, DEFAULT_CONFIG }
