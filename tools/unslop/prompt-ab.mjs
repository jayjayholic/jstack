#!/usr/bin/env node
// Decides a prompt change from held-out scores, and checks an LLM judge against human labels.
//   node prompt-ab.mjs compare <before.jsonl> <after.jsonl> [--max-drop-pp 2] [--min-n 50] [--json]
//       one row per held-out case in each arm: {"case": "<id>", "score": <0..1>}. Cases are paired by id; the paired
//       difference (after - before) gets a seeded bootstrap 95% interval, in percentage points. Verdict: ok when the
//       interval's lower end stays above -max-drop-pp, regressed when it does not, too-few under min-n, mismatched
//       when a case is in one arm only (both arms must run the same cases).
//   node prompt-ab.mjs judge <human.jsonl> <judge.jsonl> [--min-agreement 0.8] [--min-n 30] [--json]
//       one row per case: {"case": "<id>", "label": "<label>"}. Prints agreement, Cohen's kappa and the confusion
//       pairs. Verdict: ok, uncalibrated (agreement under the bar), too-few, mismatched.
// Exit 1 when the verdict is not ok, so evidence.mjs records it as a failing check. Rows may also be a JSON array.
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

const RESAMPLES = 4000

function readRows(file) {
  const text = fs.readFileSync(file, 'utf8').trim()
  if (!text) return []
  if (text.startsWith('[')) return JSON.parse(text)
  return text.split('\n').filter(l => l.trim()).map(l => JSON.parse(l))
}

function byCase(rows, field) {
  const out = new Map()
  for (const r of rows) {
    const id = r.case ?? r.id
    if (id == null || r[field] == null) continue
    out.set(String(id), r[field])
  }
  return out
}

function pair(a, b) {
  const ids = [...a.keys()].filter(k => b.has(k)).sort()
  const onlyA = [...a.keys()].filter(k => !b.has(k))
  const onlyB = [...b.keys()].filter(k => !a.has(k))
  return { ids, missing: onlyA.length + onlyB.length, onlyA, onlyB }
}

function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const mean = xs => xs.reduce((s, x) => s + x, 0) / xs.length

function bootstrapInterval(diffs, { resamples = RESAMPLES, seed = 1 } = {}) {
  const next = rng(seed)
  const means = []
  for (let i = 0; i < resamples; i++) {
    let s = 0
    for (let j = 0; j < diffs.length; j++) s += diffs[Math.floor(next() * diffs.length)]
    means.push(s / diffs.length)
  }
  means.sort((x, y) => x - y)
  return [means[Math.floor(0.025 * (resamples - 1))], means[Math.ceil(0.975 * (resamples - 1))]]
}

function compare(beforeRows, afterRows, { maxDropPp = 2, minN = 50 } = {}) {
  const before = byCase(beforeRows, 'score')
  const after = byCase(afterRows, 'score')
  const { ids, missing, onlyA, onlyB } = pair(before, after)
  const base = { n: ids.length, missing, only_before: onlyA, only_after: onlyB, max_drop_pp: maxDropPp, min_n: minN }
  if (missing) return { verdict: 'mismatched', ...base }
  if (ids.length < minN || ids.length < 2) return { verdict: 'too-few', ...base }
  const diffs = ids.map(id => Number(after.get(id)) - Number(before.get(id)))
  if (diffs.some(d => !Number.isFinite(d))) return { verdict: 'mismatched', ...base, reason: 'non-numeric score' }
  const [lo, hi] = bootstrapInterval(diffs)
  const pp = x => Math.round(x * 10000) / 100
  const out = {
    ...base,
    before_mean: pp(mean(ids.map(id => Number(before.get(id))))),
    after_mean: pp(mean(ids.map(id => Number(after.get(id))))),
    diff_pp: pp(mean(diffs)),
    ci_pp: [pp(lo), pp(hi)],
    better: lo > 0,
  }
  return { verdict: pp(lo) < -maxDropPp ? 'regressed' : 'ok', ...out }
}

function judge(humanRows, judgeRows, { minAgreement = 0.8, minN = 30 } = {}) {
  const human = byCase(humanRows, 'label')
  const model = byCase(judgeRows, 'label')
  const { ids, missing, onlyA, onlyB } = pair(human, model)
  const base = { n: ids.length, missing, only_human: onlyA, only_judge: onlyB, min_agreement: minAgreement, min_n: minN }
  if (missing) return { verdict: 'mismatched', ...base }
  if (ids.length < minN || !ids.length) return { verdict: 'too-few', ...base }
  const labels = [...new Set(ids.flatMap(id => [String(human.get(id)), String(model.get(id))]))].sort()
  const agree = ids.filter(id => String(human.get(id)) === String(model.get(id))).length
  const po = agree / ids.length
  let pe = 0
  for (const l of labels) {
    const ph = ids.filter(id => String(human.get(id)) === l).length / ids.length
    const pm = ids.filter(id => String(model.get(id)) === l).length / ids.length
    pe += ph * pm
  }
  const kappa = pe >= 1 ? (po === 1 ? 1 : 0) : (po - pe) / (1 - pe)
  const confusion = {}
  for (const id of ids) {
    const h = String(human.get(id))
    const m = String(model.get(id))
    if (h !== m) confusion[`${h}->${m}`] = (confusion[`${h}->${m}`] ?? 0) + 1
  }
  const r3 = x => Math.round(x * 1000) / 1000
  const majority = Math.max(...labels.map(l => ids.filter(id => String(human.get(id)) === l).length)) / ids.length
  return { verdict: po < minAgreement ? 'uncalibrated' : 'ok', ...base, agreement: r3(po), kappa: r3(kappa), majority_share: r3(majority), confusion }
}

function flag(argv, name, def) {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] != null ? Number(argv[i + 1]) : def
}

function print(res, json) {
  // unslop-ignore: perf.log-whole-payload --json prints the verdict on purpose; it holds case ids and numbers only
  if (json) { console.log(JSON.stringify(res, null, 2)); return }
  for (const [k, v] of Object.entries(res)) console.log(`${k}=${Array.isArray(v) ? `[${v.join(', ')}]` : typeof v === 'object' && v ? JSON.stringify(v) : v}`)
}

function main(argv) {
  const [cmd, a, b] = argv
  const json = argv.includes('--json')
  if (cmd === 'compare' && a && b) {
    const res = compare(readRows(a), readRows(b), { maxDropPp: flag(argv, '--max-drop-pp', 2), minN: flag(argv, '--min-n', 50) })
    print(res, json)
    return res.verdict === 'ok' ? 0 : 1
  }
  if (cmd === 'judge' && a && b) {
    const res = judge(readRows(a), readRows(b), { minAgreement: flag(argv, '--min-agreement', 0.8), minN: flag(argv, '--min-n', 30) })
    print(res, json)
    return res.verdict === 'ok' ? 0 : 1
  }
  console.log('usage: prompt-ab.mjs compare <before.jsonl> <after.jsonl> [--max-drop-pp 2] [--min-n 50] [--json]\n       prompt-ab.mjs judge <human.jsonl> <judge.jsonl> [--min-agreement 0.8] [--min-n 30] [--json]')
  return 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)))

export { compare, judge, bootstrapInterval, readRows, main }
