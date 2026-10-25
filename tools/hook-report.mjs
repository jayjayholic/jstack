#!/usr/bin/env node
// jstack hook-report: what the guard hooks blocked and how agents took it.
// Usage: node hook-report.mjs [--days 7] [--log <file>] [--json]
// Reads the JSONL the hooks write (default ~/.jstack/guard-log.jsonl, or "log" in ~/.jstack/guards.json).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt }
let cfgLog
try { cfgLog = JSON.parse(fs.readFileSync(process.env.JSTACK_GUARDS_CONFIG || path.join(os.homedir(), '.jstack', 'guards.json'), 'utf8')).log } catch {}
const file = opt('--log', process.env.JSTACK_GUARDS_LOG || cfgLog || path.join(os.homedir(), '.jstack', 'guard-log.jsonl'))
const days = Number(opt('--days', 7))
const since = Date.now() - days * 86400_000

let rows = []
try {
  rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
} catch {
  console.log(`No guard log at ${file}. Nothing blocked yet, or the hooks aren't enabled for any project.`)
  process.exit(0)
}
rows = rows.filter(r => Date.parse(r.t) >= since)

const day = r => r.t.slice(0, 10)
const who = r => `${r.agentType ?? 'agent'}:${String(r.agent).slice(0, 8)}`
const perDay = {}
const perAgent = {}
for (const r of rows) {
  const d = (perDay[day(r)] ??= { blocks: 0, heavy: 0, scan: 0, followed: 0, ignored: 0, agents: new Set(), cleanups: 0, killed: 0 })
  if (r.type === 'block') {
    d.blocks++; d[r.guard === 'scan' ? 'scan' : 'heavy']++; d.agents.add(r.session + r.agent)
    const a = (perAgent[r.session + r.agent] ??= { who: who(r), cwd: r.cwd, blocks: 0, guards: new Set(), last: '' })
    a.blocks++; a.guards.add(r.guard); a.last = r.command
  } else if (r.type === 'next') d[r.followed ? 'followed' : 'ignored']++
  else if (r.type === 'cleanup') { d.cleanups++; d.killed += r.killed?.length ?? 0 }
}
const struggling = Object.values(perAgent).filter(a => a.blocks >= 2).sort((a, b) => b.blocks - a.blocks)
const ignored = rows.filter(r => r.type === 'next' && !r.followed).slice(-10)

if (args.includes('--json')) {
  console.log(JSON.stringify({
    file, days,
    perDay: Object.fromEntries(Object.entries(perDay).map(([k, v]) => [k, { ...v, agents: v.agents.size }])),
    struggling: struggling.map(a => ({ ...a, guards: [...a.guards] })),
    ignored,
  }, null, 2))
  process.exit(0)
}

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '-')
console.log(`Guard report, last ${days} days (${file})\n`)
console.log('day         blocks  heavy  scan  agents  next=advice  cleanups(killed)')
for (const [k, v] of Object.entries(perDay).sort()) {
  console.log(`${k}  ${String(v.blocks).padStart(6)}  ${String(v.heavy).padStart(5)}  ${String(v.scan).padStart(4)}  ${String(v.agents.size).padStart(6)}  ${pct(v.followed, v.followed + v.ignored).padStart(11)}  ${v.cleanups}(${v.killed})`)
}
console.log(`\nRepeat blocks (same agent blocked 2+ times, a sign it's struggling): ${struggling.length}`)
for (const a of struggling.slice(0, 15)) console.log(`  ${a.blocks}x ${a.who} [${[...a.guards].join(',')}] ${a.cwd}\n     last: ${String(a.last).slice(0, 140)}`)
console.log(`\nNext call after a block that did NOT take the advice: ${rows.filter(r => r.type === 'next' && !r.followed).length}`)
for (const r of ignored) console.log(`  ${r.t.slice(5, 16)} ${who(r)} [${r.guard}] -> ${r.tool}: ${String(r.command ?? '').slice(0, 120)}`)
