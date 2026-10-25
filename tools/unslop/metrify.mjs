#!/usr/bin/env node
// /unslop:metrify: a local dashboard from the run records in .jstack/metrics/runs/ (written by every /unslop run).
// It answers one question: does the slop stop coming back? Trend per domain, top recurring slop, each rule's effect
// and false-positive rate, which pre-flight questions would have caught what, time to fix and budgets.
//   node metrify.mjs [--repo .] [--out .jstack/local/site/metrify/index.html] [--json]
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadRecords, trends } from './metrics.mjs'
import { esc, page, sparkline, writeSite } from './site.mjs'

const pct = x => x == null ? 'n/a' : `${Math.round(x * 100)}%`

function verdict(series) {
  if (series.length < 2) return { text: 'one run so far', cls: '' }
  const half = Math.floor(series.length / 2)
  const avg = xs => xs.reduce((a, b) => a + b, 0) / (xs.length || 1)
  const early = avg(series.slice(0, half).map(p => p.confirmed)), late = avg(series.slice(half).map(p => p.confirmed))
  if (late < early) return { text: `down: ${early.toFixed(1)} to ${late.toFixed(1)} confirmed per run`, cls: 'ok' }
  if (late > early) return { text: `up: ${early.toFixed(1)} to ${late.toFixed(1)} confirmed per run`, cls: 'high' }
  return { text: 'flat', cls: 'warn' }
}

function render(t, { repoName = '' } = {}) {
  if (!t.runs) {
    return page({ title: 'Unslop metrics', description: 'No runs recorded yet', body: `<h1>Unslop metrics</h1><p>No /unslop run has been recorded in this repo yet. Every run writes one record to <code>.jstack/metrics/runs/</code> when its report is built; run <code>/unslop</code> once and come back.</p>` })
  }
  const tiles = [
    ['runs', t.runs],
    ['confirmed, latest run', t.confirmedSeries.at(-1)?.y ?? 0],
    ['slop that came back after a fix', pct(t.recurrenceRate)],
    ['median time to fix', t.medianTimeToFixMin == null ? 'n/a' : `${t.medianTimeToFixMin} min`],
    ['false positives (your verdicts)', pct(t.falsePositiveRate)],
  ].map(([k, v]) => `<div class="tile"><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join('')
  const domains = Object.entries(t.domains).sort((a, b) => b[1].reduce((s, p) => s + p.confirmed, 0) - a[1].reduce((s, p) => s + p.confirmed, 0))
  const domainCards = domains.map(([d, series]) => {
    const v = verdict(series)
    return `<div class="card"><h3>${esc(d)} <span class="tag ${v.cls}">${esc(v.text)}</span></h3>${sparkline(series.map(p => ({ x: `${p.x} ${p.run}`, y: p.confirmed })), { label: `confirmed ${d} findings per run` })}<p class="muted">confirmed per run; candidates in total ${series.reduce((s, p) => s + p.candidates, 0)}</p></div>`
  }).join('')
  const recurring = t.recurring.slice(0, 15).map(f => `<tr><td><code>${esc(f.rule)}</code></td><td>${esc(f.domain)}</td><td>${f.runs}</td><td>${f.recurred ? `<span class="tag high">${f.recurred}x after a fix</span>` : 'never fixed'}</td><td class="muted">${esc(f.first.slice(0, 10))} to ${esc(f.last.slice(0, 10))}</td><td class="muted"><code>${esc(f.fp.split('|')[1] ?? f.fp)}</code></td></tr>`).join('')
  const rules = t.rules.slice(0, 20).map(r => `<tr><td><code>${esc(r.rule)}</code></td><td>${r.total}</td><td>${r.early}</td><td>${r.late}</td><td>${r.late < r.early ? '<span class="tag ok">fewer</span>' : r.late > r.early ? '<span class="tag high">more</span>' : '<span class="tag">same</span>'}</td><td>${pct(r.falsePositiveRate)} <span class="muted">(${r.verdicts} verdicts)</span></td></tr>`).join('')
  const questions = t.questions.slice(0, 20).map(q => `<tr><td><code>${esc(q.question)}</code></td><td>${esc(q.domain)}</td><td>${q.wouldHaveCaught}</td><td>${q.notAsked}</td><td>${q.askedButEscaped}</td><td>${q.unknown}</td></tr>`).join('')
  const budgets = t.budgets.slice(-20).map(b => `<tr><td>${esc(b.run)}</td><td><code>${esc(b.rule)}</code></td><td>${esc(b.value)}</td><td>${esc(b.budget)}</td><td>${b.met ? '<span class="tag ok">met</span>' : '<span class="tag high">over</span>'}</td><td>${esc(b.stage)}</td></tr>`).join('')
  const table = (head, rows, empty) => rows ? `<div class="scroll"><table><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="muted">${esc(empty)}</p>`
  const body = `
<h1>Is the slop coming back?</h1>
<p class="muted">${esc(repoName)} · ${t.runs} recorded run(s) · from <code>.jstack/metrics/runs/</code></p>
<div class="card"><h3>Confirmed findings per run</h3>${sparkline(t.confirmedSeries, { width: 600, height: 80, label: 'confirmed findings per run' })}</div>
<div class="tiles">${tiles}</div>
<h2>Trend per domain</h2><p class="muted">Each line is one domain's confirmed findings per run. "Down" compares the later half of the runs with the earlier half.</p>
<div class="grid2">${domainCards}</div>
<h2>Top recurring slop</h2><p class="muted">The same fingerprint (rule + place + shape) seen in more than one run, or back after it was fixed.</p>
${table(['rule', 'domain', 'runs seen', 'came back', 'first to last', 'where'], recurring, 'Nothing has recurred yet.')}
<h2>Effect of each rule</h2><p class="muted">Confirmed hits in the earlier half of the runs vs the later half, and the share of your verdicts that said "not a bug".</p>
${table(['rule', 'confirmed', 'earlier half', 'later half', 'trend', 'false positives'], rules, 'No confirmed findings yet.')}
<h2>Pre-flight questions that would have caught it</h2><p class="muted">For each confirmed finding, the pack questions written to prevent its failure class. "Not asked" means the branch's .agent/preflight.md never mentions that question: ask it next time. "Asked, still escaped" means the answer did not hold.</p>
${table(['question', 'domain', 'would have caught', 'not asked', 'asked, still escaped', 'no pre-flight file'], questions, 'No confirmed finding maps to a pre-flight question yet.')}
<h2>Budgets</h2>
${table(['run', 'rule', 'value', 'budget', '', 'stage'], budgets, 'No measured budgets in the recorded runs.')}
<details><summary>Raw numbers</summary><pre>${esc(JSON.stringify({ domains: t.domains }, null, 1))}</pre></details>`
  return page({ title: 'Unslop metrics', description: 'Does the slop stop recurring? Trends from every /unslop run', body })
}

function main(argv) {
  const get = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }
  const repo = path.resolve(get('--repo') ?? '.')
  const t = trends(loadRecords(repo))
  if (argv.includes('--json')) { console.log(JSON.stringify(t, null, 2)); return 0 }
  const out = path.resolve(get('--out') ?? path.join(repo, '.jstack', 'local', 'site', 'metrify', 'index.html'))
  writeSite(out, render(t, { repoName: path.basename(repo) }))
  console.log(`${out}: ${t.runs} run(s)`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)))

export { render, verdict }
