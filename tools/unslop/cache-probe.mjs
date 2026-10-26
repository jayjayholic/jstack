#!/usr/bin/env node
// Confirms a prompt-cache red flag from the provider's own usage numbers, never from reading the code.
//   node cache-probe.mjs replay <first.json> <second.json> [--max-miss-pct 50]
//       two responses (or their usage objects) of the SAME request sent twice within the TTL. The second call must
//       read the stable prefix back. Prints verdict=..., miss_pct=..., read/write/uncached tokens per call.
//   node cache-probe.mjs usage <records.jsonl|.json> [--by site] [--min-hit-pct 70] [--ttl-min 5]
//       existing usage records (one JSON object per line, or an array), grouped by a field. Per group: calls,
//       hit_pct, reads_per_write against the break-even, 1-hour write tokens, and the share of gaps over the TTL.
// Reads Anthropic usage (input_tokens + cache_read_input_tokens + cache_creation_input_tokens, cache_creation
// .ephemeral_1h_input_tokens), OpenAI (prompt/input tokens with *_tokens_details.cached_tokens, cache_write_tokens)
// and OpenTelemetry GenAI attributes (gen_ai.usage.*). Exit 1 when a verdict is not "ok", so evidence.mjs records
// it as a failing check; the miss_pct line is the value for --budget/--value-regex measurements.
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

const WRITE_5M = 1.25
const WRITE_1H = 2
const READ = 0.1
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0)

// One response, usage object or usage row -> { uncached, read, write, write1h, total } in prompt tokens.
function normalize(x) {
  const u = x?.usage ?? x?.response?.usage ?? x ?? {}
  const otel = k => u[`gen_ai.usage.${k}`] ?? u.attributes?.[`gen_ai.usage.${k}`]
  if (otel('input_tokens') != null) {
    const read = num(otel('cache_read.input_tokens'))
    const write = num(otel('cache_creation.input_tokens'))
    const total = num(otel('input_tokens'))
    return { uncached: Math.max(0, total - read - write), read, write, write1h: 0, total }
  }
  if (u.cache_read_input_tokens != null || u.cache_creation_input_tokens != null || (u.input_tokens != null && u.input_tokens_details == null && u.prompt_tokens == null)) {
    const read = num(u.cache_read_input_tokens)
    const write = num(u.cache_creation_input_tokens)
    const uncached = num(u.input_tokens)
    return { uncached, read, write, write1h: num(u.cache_creation?.ephemeral_1h_input_tokens), total: uncached + read + write }
  }
  const details = u.input_tokens_details ?? u.prompt_tokens_details ?? {}
  const total = num(u.input_tokens ?? u.prompt_tokens)
  const read = num(details.cached_tokens)
  const write = num(u.cache_write_tokens ?? details.cache_write_tokens)
  return { uncached: Math.max(0, total - read - write), read, write, write1h: 0, total }
}

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0)

// Reads per written token at which a cache breaks even: the write premium over the read saving.
function breakEven(write, write1h) {
  if (!write) return 0
  const premium = ((write - write1h) * (WRITE_5M - 1) + write1h * (WRITE_1H - 1)) / write
  return Math.round((premium / (1 - READ)) * 100) / 100
}

function replay(first, second, { maxMissPct = 50 } = {}) {
  const a = normalize(first)
  const b = normalize(second)
  const missPct = pct(b.uncached + b.write, b.total)
  let verdict = 'ok'
  let why = 'the second call read the prefix the first one wrote'
  if (!a.read && !a.write && !b.read && !b.write) { verdict = 'not-cached'; why = 'neither call wrote or read: no breakpoint, a prompt under the minimum cacheable length, or no cache on this provider' }
  else if (!b.read && b.write) { verdict = 'write-only'; why = 'the second identical call wrote again and read nothing: the breakpoint sits on content that differs per call, or the prefix before it changed' }
  else if (missPct > maxMissPct) { verdict = 'prefix-moved'; why = `the second call read ${b.read} but still paid full or write price on ${missPct}% of its prompt` }
  return { verdict, why, missPct, first: a, second: b }
}

function readRecords(file) {
  const text = fs.readFileSync(file, 'utf8').trim()
  if (text.startsWith('[')) return JSON.parse(text)
  return text.split('\n').filter(l => l.trim()).map(l => JSON.parse(l))
}

function usageReport(records, { by = 'site', minHitPct = 70, ttlMin = 5 } = {}) {
  const groups = new Map()
  for (const r of records) {
    const k = String(r[by] ?? r.attributes?.[by] ?? '(none)')
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(r)
  }
  const out = []
  for (const [site, rows] of groups) {
    const s = rows.map(normalize).reduce((a, n) => ({ uncached: a.uncached + n.uncached, read: a.read + n.read, write: a.write + n.write, write1h: a.write1h + n.write1h, total: a.total + n.total }), { uncached: 0, read: 0, write: 0, write1h: 0, total: 0 })
    const times = rows.map(r => Date.parse(r.at ?? r.timestamp ?? r.created_at ?? '')).filter(Number.isFinite).sort((x, y) => x - y)
    const gaps = times.slice(1).map((t, i) => t - times[i])
    const hitPct = pct(s.read, s.total)
    const readsPerWrite = s.write ? Math.round((s.read / s.write) * 100) / 100 : null
    const even = breakEven(s.write, s.write1h)
    let verdict = 'ok'
    if (!s.read && !s.write) verdict = 'not-cached'
    else if (s.write && readsPerWrite < even) verdict = 'write-only'
    else if (hitPct < minHitPct) verdict = 'below-target'
    out.push({ site, calls: rows.length, hitPct, missPct: Math.round((100 - hitPct) * 10) / 10, readsPerWrite, breakEven: even, write1h: s.write1h, gapsOverTtlPct: gaps.length ? pct(gaps.filter(g => g > ttlMin * 60000).length, gaps.length) : null, verdict, ...s })
  }
  return out.sort((a, b) => b.total - a.total)
}

function main(argv) {
  const get = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
  const [mode, ...rest] = argv
  const files = rest.filter((a, i) => !a.startsWith('--') && !rest[i - 1]?.startsWith('--'))
  if (mode === 'replay' && files.length === 2) {
    const r = replay(JSON.parse(fs.readFileSync(files[0], 'utf8')), JSON.parse(fs.readFileSync(files[1], 'utf8')), { maxMissPct: Number(get('--max-miss-pct', 50)) })
    for (const [n, c] of [['first', r.first], ['second', r.second]]) process.stdout.write(`${n}: uncached=${c.uncached} cache_read=${c.read} cache_write=${c.write} cache_write_1h=${c.write1h}\n`)
    process.stdout.write(`verdict=${r.verdict} miss_pct=${r.missPct}\n${r.why}\n`)
    return r.verdict === 'ok' ? 0 : 1
  }
  if (mode === 'usage' && files.length === 1) {
    const rows = usageReport(readRecords(files[0]), { by: get('--by', 'site'), minHitPct: Number(get('--min-hit-pct', 70)), ttlMin: Number(get('--ttl-min', 5)) })
    for (const r of rows) process.stdout.write(`site=${r.site} calls=${r.calls} hit_pct=${r.hitPct} miss_pct=${r.missPct} reads_per_write=${r.readsPerWrite ?? '-'} break_even=${r.breakEven} cache_write_1h=${r.write1h} gaps_over_ttl_pct=${r.gapsOverTtlPct ?? '-'} verdict=${r.verdict}\n`)
    return rows.every(r => r.verdict === 'ok') ? 0 : 1
  }
  process.stderr.write('usage: cache-probe.mjs replay <first.json> <second.json> [--max-miss-pct N] | usage <records> [--by field] [--min-hit-pct N] [--ttl-min N]\n')
  return 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)))

export { normalize, replay, usageReport, breakEven, main }
