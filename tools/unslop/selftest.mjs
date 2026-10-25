#!/usr/bin/env node
// Measures the static scanner against the golden fixtures in skills/unslop/fixtures/{dev,holdout}/<domain>.json.
// Each case is a tiny repo: a "slop" case must fire its rule at the expected lines, a "near-miss" case (clean code
// that looks like the slop) must stay silent. Prints per rule TP / FP / FN, precision and recall with Wilson 95%
// intervals, separately for dev and holdout, plus coverage (every static rule needs 1 slop + 2 near-misses in dev).
// Holdout numbers are reported, never tuned against. A rule whose dev and holdout precision intervals do not
// overlap is overfit and the report says it goes back to eyes-hint.
//   node selftest.mjs [--set dev|holdout|all] [--rule id] [--json]
// Exit 1 when any dev case fails or a static rule lacks coverage.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { scan } from './scan.mjs'
import { loadRules, JSTACK_ROOT } from './rules.mjs'
import { wilson } from './stats.mjs'

const FIXTURES = path.join(JSTACK_ROOT, 'skills', 'unslop', 'fixtures')
const STATIC = new Set(['regex', 'script'])

function loadCases(set, dir = FIXTURES) {
  const d = path.join(dir, set)
  let files = []
  try { files = fs.readdirSync(d).filter(f => f.endsWith('.json')).sort() } catch { return [] }
  return files.flatMap(f => {
    const j = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'))
    return j.cases.map(c => ({ ...c, domain: j.domain, set }))
  })
}

function materialize(c) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unslop-case-'))
  for (const [p, text] of Object.entries(c.files)) {
    const abs = path.join(root, p)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, text)
  }
  return root
}

function runCase(c, rulesById) {
  const rule = rulesById.get(c.rule)
  if (!rule) return { case: c, error: `unknown rule ${c.rule}`, tp: 0, fp: 0, fn: c.expect.length, hits: [] }
  const root = materialize(c)
  try {
    const res = scan({ root, rules: [rule], diffStatus: c.diffStatus })
    const hits = res.candidates.map(h => ({ path: h.path, line: h.line }))
    const key = h => `${h.path}:${h.line}`
    const got = new Set(hits.map(key))
    const want = new Set(c.expect.map(key))
    const tp = [...want].filter(k => got.has(k)).length
    const fn = want.size - tp
    const fp = [...got].filter(k => !want.has(k)).length
    return { case: c, tp, fp, fn, hits, notChecked: res.notChecked }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function summarize(results) {
  const per = new Map()
  for (const r of results) {
    const s = per.get(r.case.rule) ?? { rule: r.case.rule, domain: r.case.domain, tp: 0, fp: 0, fn: 0, slop: 0, nearMiss: 0, failed: [] }
    s.tp += r.tp; s.fp += r.fp; s.fn += r.fn
    if (r.case.kind === 'slop') s.slop++; else s.nearMiss++
    if (r.error || r.fp || r.fn) s.failed.push({ id: r.case.id, kind: r.case.kind, error: r.error ?? null, fp: r.fp, fn: r.fn, hits: r.hits })
    per.set(r.case.rule, s)
  }
  for (const s of per.values()) {
    s.precision = wilson(s.tp, s.tp + s.fp)
    s.recall = wilson(s.tp, s.tp + s.fn)
  }
  return [...per.values()].sort((a, b) => a.rule.localeCompare(b.rule))
}

function selftest({ sets = ['dev', 'holdout'], ruleIds = null, fixturesDir = FIXTURES } = {}) {
  const rules = loadRules({ repo: null }).filter(r => STATIC.has(r.engine) && (!ruleIds || ruleIds.includes(r.id)))
  const rulesById = new Map(rules.map(r => [r.id, r]))
  const out = { sets: {}, coverage: [], overfit: [] }
  for (const set of sets) {
    const cases = loadCases(set, fixturesDir).filter(c => !ruleIds || ruleIds.includes(c.rule))
    const results = cases.map(c => runCase(c, rulesById))
    out.sets[set] = { cases: cases.length, rules: summarize(results) }
  }
  const dev = out.sets.dev?.rules ?? []
  for (const r of rules) {
    const s = dev.find(x => x.rule === r.id)
    if (!s || s.slop < 1 || s.nearMiss < 2) out.coverage.push({ rule: r.id, slop: s?.slop ?? 0, nearMiss: s?.nearMiss ?? 0 })
  }
  for (const h of out.sets.holdout?.rules ?? []) {
    const d = dev.find(x => x.rule === h.rule)
    if (!d || h.tp + h.fp === 0 || d.tp + d.fp === 0) continue
    if (h.precision.upper < d.precision.lower || d.precision.upper < h.precision.lower) out.overfit.push({ rule: h.rule, dev: d.precision, holdout: h.precision, action: 'demote to eyes-hint' })
  }
  out.failed = Object.entries(out.sets).flatMap(([set, s]) => s.rules.flatMap(r => r.failed.map(f => ({ set, rule: r.rule, ...f }))))
  out.ok = !out.coverage.length && !out.failed.some(f => f.set === 'dev')
  return out
}

const pct = x => (x == null ? '  -  ' : `${(x * 100).toFixed(0).padStart(3)}%`)
const ci = w => (w.p == null ? 'n/a' : `${pct(w.p)} [${pct(w.lower)}-${pct(w.upper)}]`)

function render(res) {
  const lines = []
  for (const [set, s] of Object.entries(res.sets)) {
    const all = s.rules.reduce((a, r) => ({ tp: a.tp + r.tp, fp: a.fp + r.fp, fn: a.fn + r.fn }), { tp: 0, fp: 0, fn: 0 })
    lines.push(`== ${set}: ${s.cases} case(s), ${s.rules.length} rule(s); precision ${ci(wilson(all.tp, all.tp + all.fp))}, recall ${ci(wilson(all.tp, all.tp + all.fn))}`)
    for (const r of s.rules) lines.push(`  ${r.rule.padEnd(32)} tp ${String(r.tp).padStart(2)} fp ${String(r.fp).padStart(2)} fn ${String(r.fn).padStart(2)}  precision ${ci(r.precision)}  recall ${ci(r.recall)}${r.failed.length ? '  FAIL ' + r.failed.map(f => f.id).join(',') : ''}`)
  }
  for (const c of res.coverage) lines.push(`coverage: ${c.rule} has ${c.slop} slop and ${c.nearMiss} near-miss case(s) in dev; needs 1 and 2`)
  for (const o of res.overfit) lines.push(`overfit: ${o.rule} dev ${ci(o.dev)} vs holdout ${ci(o.holdout)} -> ${o.action}`)
  for (const f of res.failed) lines.push(`fail [${f.set}] ${f.rule} ${f.kind} ${f.id}: ${f.error ?? `fp ${f.fp} fn ${f.fn}`} hits ${JSON.stringify(f.hits)}`)
  lines.push(res.ok ? 'selftest: ok' : 'selftest: FAILED')
  return lines.join('\n') + '\n'
}

function main(argv) {
  const get = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null }
  const set = get('--set') ?? 'all'
  const rule = get('--rule')
  const res = selftest({ sets: set === 'all' ? ['dev', 'holdout'] : [set], ruleIds: rule ? rule.split(',') : null })
  process.stdout.write(argv.includes('--json') ? JSON.stringify(res, null, 2) + '\n' : render(res))
  return res.ok ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)))

export { selftest, loadCases, runCase, render, FIXTURES }
