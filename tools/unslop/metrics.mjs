#!/usr/bin/env node
// The time series behind /unslop:metrify. Every /unslop run leaves one record in .jstack/metrics/runs/<run>.json
// (committed, one file per run so parallel branches never conflict): what the scan found per domain and rule (before),
// what got confirmed, fixed and verified (after), each finding's fingerprint (to see the same slop come back), time to
// fix, the feedback verdicts given on the run, measured budgets met or missed, and which pre-flight questions would
// have caught each confirmed finding and whether the pre-flight asked them.
//   node metrics.mjs record <run-dir> [--repo .] [--scope branch|pr|recent|full] [--base <ref>]
//   node metrics.mjs show [--repo .] [--json]
// report.mjs calls record() at the end of every run, so nobody has to remember it.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { states, readEvidence, rows as ledgerRows } from './ledger.mjs'
import { loadPacks } from './rules.mjs'
import { redact, scanFields } from '../memory/secrets.mjs'

const RUNS_DIR = path.join('.jstack', 'metrics', 'runs')
const FIXED = new Set(['FIXED', 'VERIFIED', 'RECORDED'])
const CONFIRMED_OR_LATER = new Set(['CONFIRMED', 'TEST_RED', 'FIX_PROPOSED', 'APPROVED', 'FIXED', 'VERIFIED', 'RECORDED'])

function readJsonl(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)] } catch { return [] } }) } catch { return [] }
}

const bump = (o, k, n = 1) => { o[k] = (o[k] ?? 0) + n; return o }

function feedbackRows(repo) {
  return readJsonl(path.join(repo, '.jstack', 'local', 'feedback.jsonl'))
}

function ruleIndex(packs = loadPacks()) {
  const rules = new Map()
  for (const p of packs) for (const r of p.rules ?? []) rules.set(r.id, { ...r, domain: p.domain })
  return { rules, questions: packs.flatMap(p => (p.questions ?? []).map(q => ({ ...q, domain: p.domain }))) }
}

function gitHead(repo) {
  const r = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: repo, encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : null
}

// One record for a finished run. Pure apart from reading the run dir, the repo's feedback and its pre-flight file.
function buildRecord(runDir, { repo, scope = null, base = null, packs, now = new Date() } = {}) {
  const cands = new Map(readJsonl(path.join(runDir, 'candidates.jsonl')).map(c => [c.id, c]))
  const all = ledgerRows(runDir)
  const st = states(runDir)
  const { rules, questions } = ruleIndex(packs)
  const run = path.basename(runDir)
  const before = { candidates: 0, byDomain: {}, byRule: {} }
  const confirmed = { total: 0, byDomain: {}, byRule: {} }
  const after = { fixed: 0, verified: 0, open: 0, dismissed: 0, unproven: 0, suppressed: 0 }
  const fingerprints = [], timeToFix = [], budgets = [], caughtBy = []
  const preflight = repo ? readText(path.join(repo, '.agent', 'preflight.md')) : null
  for (const [finding, last] of st) {
    const first = all.find(r => r.finding === finding)
    const c = cands.get(first?.candidate) ?? {}
    const domain = c.domain ?? 'unknown'
    const rule = c.rule ?? 'novel'
    before.candidates++; bump(before.byDomain, domain); bump(before.byRule, rule)
    if (last.state === 'DISMISSED') after.dismissed++
    else if (last.state === 'UNPROVEN') after.unproven++
    else if (last.state === 'SUPPRESSED') after.suppressed++
    else if (!CONFIRMED_OR_LATER.has(last.state)) after.open++
    if (CONFIRMED_OR_LATER.has(last.state)) {
      confirmed.total++; bump(confirmed.byDomain, domain); bump(confirmed.byRule, rule)
      if (FIXED.has(last.state)) after.fixed++
      if (last.state === 'VERIFIED' || last.state === 'RECORDED') after.verified++
      const fc = rules.get(rule)?.failureClass ?? null
      for (const q of questions.filter(q => fc && (q.prevents ?? []).includes(fc))) {
        caughtBy.push({ finding, rule, question: q.id, domain: q.domain, asked: preflight == null ? null : preflight.includes(q.id) })
      }
    }
    if (c.fingerprint) fingerprints.push({ fp: c.fingerprint, rule, domain, state: last.state })
    const conf = all.find(r => r.finding === finding && r.state === 'CONFIRMED')
    const ver = all.find(r => r.finding === finding && r.state === 'VERIFIED')
    if (conf && ver) timeToFix.push({ finding, rule, minutes: Math.max(0, Math.round((Date.parse(ver.at) - Date.parse(conf.at)) / 60000)) })
    for (const r of all.filter(r => r.finding === finding)) {
      for (const rel of r.evidence ?? []) {
        const ev = readEvidence(runDir, rel)
        if (ev?.kind === 'measurement' && ev.budget != null) budgets.push({ finding, rule, evidence: ev.id, budget: ev.budget, value: ev.value ?? null, met: ev.overBudget === false, stage: r.state })
      }
    }
  }
  const fb = { accepted: 0, rejected: 0, byRule: {} }
  for (const f of repo ? feedbackRows(repo) : []) {
    if (f.run !== run) continue
    const k = f.verdict === 'accepted' ? 'accepted' : String(f.verdict).startsWith('rejected') ? 'rejected' : null
    if (!k) continue
    fb[k]++
    const r = fb.byRule[f.rule] ??= { accepted: 0, rejected: 0 }
    r[k]++
  }
  const record = { version: 1, run, at: now.toISOString(), scope, base, head: repo ? gitHead(repo) : null, before, confirmed, after, fingerprints, timeToFix, feedback: fb, budgets, caughtBy }
  return record
}

function readText(f) { try { return fs.readFileSync(f, 'utf8') } catch { return null } }

// Writes the record, refusing to store anything that looks like a secret (redacted in place, counted).
function writeRecord(repo, record) {
  const clean = JSON.parse(JSON.stringify(record, (k, v) => typeof v === 'string' && scanFields({ v }).length ? redact(v).text : v))
  const dir = path.join(repo, RUNS_DIR)
  fs.mkdirSync(dir, { recursive: true })
  const safe = String(record.run).replace(/[^\w.-]/g, '_')
  const file = path.join(dir, `${safe}.json`)
  fs.writeFileSync(file, JSON.stringify(clean, null, 2) + '\n')
  return file
}

function record(runDir, opts) {
  const rec = buildRecord(runDir, opts)
  return { file: writeRecord(opts.repo, rec), record: rec }
}

function loadRecords(repo) {
  const dir = path.join(repo, RUNS_DIR)
  let files = []
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')) } catch { return [] }
  return files.flatMap(f => { try { return [JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))] } catch { return [] } })
    .filter(r => r?.version === 1 && r.run && r.at)
    .sort((a, b) => a.at.localeCompare(b.at))
}

const median = xs => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }

// Everything metrify draws, computed from the records alone.
function trends(records) {
  const domains = {}
  const seen = new Map()
  const ruleSeries = {}
  const questions = {}
  for (const [i, r] of records.entries()) {
    const ds = new Set([...Object.keys(r.before.byDomain ?? {}), ...Object.keys(domains)])
    for (const d of ds) (domains[d] ??= []).push({ x: r.at.slice(0, 10), run: r.run, i, candidates: r.before.byDomain?.[d] ?? 0, confirmed: r.confirmed.byDomain?.[d] ?? 0 })
    for (const [rule, n] of Object.entries(r.confirmed.byRule ?? {})) (ruleSeries[rule] ??= []).push({ i, n })
    for (const f of r.fingerprints ?? []) {
      if (['SUPPRESSED', 'DISMISSED', 'UNPROVEN'].includes(f.state)) continue
      const s = seen.get(f.fp) ?? { fp: f.fp, rule: f.rule, domain: f.domain, runs: 0, first: r.at, last: r.at, fixedAt: null, recurred: 0 }
      if (s.fixedAt && s.fixedAt < r.at && s.lastRun !== r.run) { s.recurred++; s.fixedAt = null }
      s.runs++; s.last = r.at; s.lastRun = r.run
      if (FIXED.has(f.state)) s.fixedAt = r.at
      seen.set(f.fp, s)
    }
    for (const q of r.caughtBy ?? []) {
      const s = questions[q.question] ??= { question: q.question, domain: q.domain, wouldHaveCaught: 0, askedButEscaped: 0, notAsked: 0, unknown: 0 }
      s.wouldHaveCaught++
      if (q.asked === true) s.askedButEscaped++
      else if (q.asked === false) s.notAsked++
      else s.unknown++
    }
  }
  const half = Math.floor(records.length / 2)
  const rules = Object.entries(ruleSeries).map(([rule, xs]) => {
    const early = xs.filter(x => x.i < half).reduce((a, x) => a + x.n, 0)
    const late = xs.filter(x => x.i >= half).reduce((a, x) => a + x.n, 0)
    const fb = records.reduce((a, r) => { const f = r.feedback?.byRule?.[rule]; if (f) { a.accepted += f.accepted; a.rejected += f.rejected } return a }, { accepted: 0, rejected: 0 })
    const n = fb.accepted + fb.rejected
    return { rule, total: early + late, early, late, falsePositiveRate: n ? fb.rejected / n : null, verdicts: n }
  }).sort((a, b) => b.total - a.total)
  const fps = [...seen.values()]
  const fbAll = records.reduce((a, r) => ({ accepted: a.accepted + (r.feedback?.accepted ?? 0), rejected: a.rejected + (r.feedback?.rejected ?? 0) }), { accepted: 0, rejected: 0 })
  const fbN = fbAll.accepted + fbAll.rejected
  return {
    runs: records.length,
    domains,
    recurring: fps.filter(f => f.runs > 1 || f.recurred > 0).sort((a, b) => b.recurred - a.recurred || b.runs - a.runs).map(({ lastRun, ...f }) => f),
    recurrenceRate: fps.length ? fps.filter(f => f.recurred > 0).length / fps.length : null,
    rules,
    questions: Object.values(questions).sort((a, b) => b.wouldHaveCaught - a.wouldHaveCaught),
    medianTimeToFixMin: median(records.flatMap(r => (r.timeToFix ?? []).map(t => t.minutes))),
    falsePositiveRate: fbN ? fbAll.rejected / fbN : null,
    budgets: records.flatMap(r => (r.budgets ?? []).map(b => ({ ...b, run: r.run }))),
    confirmedSeries: records.map(r => ({ x: r.at.slice(0, 10), y: r.confirmed.total })),
  }
}

function main(argv) {
  const [cmd, dir] = argv
  const get = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }
  const repo = path.resolve(get('--repo') ?? '.')
  if (cmd === 'record') {
    if (!dir) { console.error('record <run-dir>'); return 2 }
    const r = record(dir, { repo, scope: get('--scope') ?? null, base: get('--base') ?? null })
    console.log(`${r.file}: ${r.record.before.candidates} candidate(s), ${r.record.confirmed.total} confirmed, ${r.record.after.verified} verified`)
    return 0
  }
  if (cmd === 'show') {
    const t = trends(loadRecords(repo))
    if (argv.includes('--json')) console.log(JSON.stringify(t, null, 2))
    else console.log(`${t.runs} run(s); recurrence ${t.recurrenceRate == null ? 'n/a' : Math.round(t.recurrenceRate * 100) + '%'}; median time to fix ${t.medianTimeToFixMin ?? 'n/a'} min; false positives ${t.falsePositiveRate == null ? 'n/a' : Math.round(t.falsePositiveRate * 100) + '%'}`)
    return 0
  }
  console.log('usage: metrics.mjs record <run-dir> [--scope ...] | show [--json]')
  return 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)))

export { buildRecord, writeRecord, record, loadRecords, trends, RUNS_DIR }
