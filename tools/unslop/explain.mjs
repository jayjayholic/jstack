#!/usr/bin/env node
// /unslop:explain: a local static site that explains what one /unslop run found and fixed, and why it matters.
// Each finding: where and when it came in (git blame at the evidence commit), the failure it causes, the engineering
// technique that applies with its source from the pack's SOURCES.md, the evidence before the fix and after it, any
// research notes written for this project, and your verdict. It adapts to you: verdicts go to
// .jstack/local/feedback.jsonl (the rule thresholds read it), preferences (short or full, muted rules) go to
// project memory as `preference` entries and change every later explanation.
//   node explain.mjs build [--run <run-dir> | --latest] [--repo .] [--out <dir>]
//   node explain.mjs feedback <run-dir> <finding> --verdict accepted|rejected --why "..." [--by human]
//   node explain.mjs prefer [--level short|full] [--mute rule,rule] [--unmute rule] [--note "..."]
// Research notes: write .jstack/local/explain/notes/<rule-id>.md and rebuild; they show under "Researched for this
// project". Everything shown is redacted for secrets first.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { states, rows as ledgerRows, readEvidence, REPORTABLE } from './ledger.mjs'
import { loadRules, loadPacks, fieldPrecision, SKILLS_DIR } from './rules.mjs'
import { esc, page, writeSite } from './site.mjs'
import { redact } from '../memory/secrets.mjs'
import { loadEntries, writeEntry, newId, Refusal } from '../memory/memory.mjs'
import { isSafeRelPath } from '../memory/anchors.mjs'

const STOP = new Set(['about', 'after', 'again', 'their', 'there', 'these', 'those', 'which', 'while', 'where', 'would', 'should', 'could', 'being', 'every', 'never', 'other', 'first', 'thing', 'point', 'until', 'under', 'still', 'without', 'within', 'before', 'because'])

function readJsonl(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)] } catch { return [] } }) } catch { return [] }
}

const tokens = s => new Set(String(s ?? '').toLowerCase().match(/[a-z][a-z-]{4,}/g)?.filter(w => !STOP.has(w)) ?? [])

// The pack's sources that share the most words with the rule. Matched by keywords, so the page says so.
function sourcesFor(rule, skillsDir = SKILLS_DIR, limit = 2) {
  if (!rule?.domain) return []
  let text = ''
  try { text = fs.readFileSync(path.join(skillsDir, `eng-${rule.domain}`, 'SOURCES.md'), 'utf8') } catch { return [] }
  const want = tokens([rule.title, rule.why, rule.fixHint, rule.confirm, rule.failureClass].join(' '))
  return text.split('\n').filter(l => l.startsWith('- ')).map(l => {
    const have = tokens(l)
    const score = [...want].filter(w => have.has(w)).length
    return { line: l.slice(2).trim(), score }
  }).filter(x => x.score >= 2).sort((a, b) => b.score - a.score).slice(0, limit)
}

function questionsFor(rule, packs) {
  if (!rule?.failureClass) return []
  return packs.flatMap(p => (p.questions ?? []).filter(q => (q.prevents ?? []).includes(rule.failureClass)).map(q => ({ ...q, domain: p.domain })))
}

// When the flagged line came in: blame at the commit the evidence ran on (before the fix), else HEAD.
function introducedBy(repo, file, line, sha) {
  if (!repo || !isSafeRelPath(file) || !Number.isInteger(line) || line < 1) return null
  // git blame (2.40) has no --end-of-options: rev is hex or HEAD and file has no leading '-', so neither parses as one.
  const rev = /^[0-9a-f]{7,40}$/.test(sha ?? '') ? sha : 'HEAD'
  const r = spawnSync('git', ['blame', '--porcelain', '-L', `${line},${line}`, rev, '--', file], { cwd: repo, encoding: 'utf8' })
  if (r.status !== 0) return null
  const out = r.stdout.replace(/\r/g, '')
  const commit = out.split(' ')[0]
  const time = /\nauthor-time (\d+)/.exec(out)?.[1]
  const summary = /\nsummary (.*)/.exec(out)?.[1] ?? ''
  if (/^0+$/.test(commit)) return { commit: null, at: null, summary: 'not committed yet' }
  return { commit: commit.slice(0, 10), at: time ? new Date(Number(time) * 1000).toISOString() : null, summary: redact(summary).text }
}

// Preferences from project memory, oldest first, merged: the latest level wins, mutes add up, unmutes remove.
function loadPrefs(repo) {
  const out = { level: 'full', mute: new Set(), notes: [] }
  const entries = loadEntries(repo).filter(e => e.kind === 'preference' && e.status === 'active').sort((a, b) => String(a.created).localeCompare(String(b.created)))
  for (const e of entries) {
    if (e.prefs?.level) out.level = e.prefs.level
    for (const r of e.prefs?.mute ?? []) out.mute.add(r)
    for (const r of e.prefs?.unmute ?? []) out.mute.delete(r)
    if (e.body) out.notes.push(e.body)
  }
  return out
}

function tail(dir, rel, n = 10) {
  try { return redact(fs.readFileSync(path.join(dir, rel), 'utf8').replace(/\r/g, '').split('\n').filter(Boolean).slice(-n).join('\n')).text } catch { return '' }
}

function readNote(repo, rule) {
  if (!rule || !/^[\w.-]+$/.test(rule)) return null
  try { return redact(fs.readFileSync(path.join(repo, '.jstack', 'local', 'explain', 'notes', `${rule}.md`), 'utf8')).text } catch { return null }
}

// Everything the page shows, as data (tests read this, not the HTML).
function collectItems(runDir, { repo, skillsDir = SKILLS_DIR } = {}) {
  const cands = new Map(readJsonl(path.join(runDir, 'candidates.jsonl')).map(c => [c.id, c]))
  const all = ledgerRows(runDir)
  const st = states(runDir)
  const rules = new Map(loadRules({ repo, skillsDir }).map(r => [r.id, r]))
  const packs = loadPacks(skillsDir)
  const field = fieldPrecision(repo)
  const feedback = readJsonl(path.join(repo, '.jstack', 'local', 'feedback.jsonl'))
  const run = path.basename(runDir)
  const items = []
  for (const [finding, last] of st) {
    if (!REPORTABLE.has(last.state) && !['DISMISSED', 'UNPROVEN'].includes(last.state)) continue
    const hist = all.filter(r => r.finding === finding)
    const c = cands.get(hist[0]?.candidate) ?? {}
    const rule = rules.get(c.rule) ?? null
    const ev = (state) => (hist.find(r => r.state === state)?.evidence ?? []).map(rel => ({ rel, ev: readEvidence(runDir, rel) })).filter(x => x.ev)
    const before = ev('CONFIRMED')
    const after = ev('VERIFIED')
    items.push({
      finding, state: last.state, rule: c.rule ?? null, domain: c.domain ?? rule?.domain ?? null, title: c.title ?? rule?.title ?? c.rule ?? finding,
      path: c.path ?? null, line: c.line ?? null, symbol: c.symbol ?? null, severity: c.severity ?? null, snippet: redact(c.snippet ?? '').text,
      scenario: c.scenario ?? rule?.why ?? null, fixHint: c.fixHint ?? rule?.fixHint ?? null, confirm: rule?.confirm ?? null, failureClass: rule?.failureClass ?? null,
      reason: last.reason ?? null,
      timeline: hist.map(r => ({ state: r.state, at: r.at, by: r.by })),
      introduced: introducedBy(repo, c.path, c.line, before[0]?.ev?.sha),
      sources: sourcesFor(rule, skillsDir),
      questions: questionsFor(rule, packs).map(q => ({ id: q.id, text: q.text, domain: q.domain })),
      before: before.map(({ rel, ev }) => ({ rel, cmd: ev.cmd, exit: ev.exit, sha: ev.sha, assertion: ev.assertion, value: ev.value ?? null, budget: ev.budget ?? null, tail: tail(runDir, ev.output) })),
      after: after.map(({ rel, ev }) => ({ rel, cmd: ev.cmd, exit: ev.exit, sha: ev.sha, value: ev.value ?? null, budget: ev.budget ?? null, tail: tail(runDir, ev.output) })),
      note: readNote(repo, c.rule),
      mode: rule?.effective ?? null,
      field: c.rule ? field[c.rule] ?? null : null,
      verdicts: feedback.filter(f => f.run === run && f.finding === finding).map(f => ({ verdict: f.verdict, why: f.why ?? null, at: f.at })),
    })
  }
  return { run, items }
}

function renderItem(it, prefs) {
  const open = prefs.level === 'full' ? ' open' : ''
  const ev = (xs, label) => xs.map(e => `<p><b>${label}:</b> <code>${esc(e.cmd)}</code> exit ${esc(e.exit)}${e.sha ? ` on ${esc(e.sha)}` : ''}${e.value != null ? `, value ${esc(e.value)} vs budget ${esc(e.budget)}` : ''}${e.assertion ? ` - "${esc(e.assertion)}"` : ''}</p>${e.tail ? `<pre>${esc(e.tail)}</pre>` : ''}`).join('')
  const when = it.introduced ? (it.introduced.commit ? `came in with <code>${esc(it.introduced.commit)}</code> "${esc(it.introduced.summary)}"${it.introduced.at ? ` on ${esc(it.introduced.at.slice(0, 10))}` : ''}` : esc(it.introduced.summary)) : 'origin not found in git'
  const timeline = it.timeline.map(t => `${esc(t.state)} ${esc(String(t.at).slice(0, 16).replace('T', ' '))} (${esc(t.by)})`).join(' → ')
  const sources = it.sources.length ? `<ul>${it.sources.map(s => `<li>${esc(s.line)}</li>`).join('')}</ul><p class="muted">Picked from the ${esc(it.domain)} pack's SOURCES.md by shared keywords; read the source before quoting it.</p>` : '<p class="muted">No source in the pack matched this rule by keywords.</p>'
  const qs = it.questions.length ? `<ul>${it.questions.map(q => `<li><code>${esc(q.id)}</code> ${esc(q.text)}</li>`).join('')}</ul>` : ''
  const mode = it.mode ? `<p class="muted">Rule mode here: <b>${esc(it.mode.mode)}</b> (${esc(it.mode.why)})${it.field ? `; your verdicts so far: ${it.field.accepted} accepted, ${it.field.rejected} rejected` : ''}.</p>` : ''
  const verdicts = it.verdicts.length ? `<p><b>Your verdict:</b> ${it.verdicts.map(v => `${esc(v.verdict)}${v.why ? ` - ${esc(v.why)}` : ''}`).join('; ')}</p>` : `<p class="muted">No verdict yet: <code>explain.mjs feedback &lt;run&gt; ${esc(it.finding)} --verdict accepted|rejected --why "..."</code></p>`
  return `<div class="card" id="${esc(it.finding)}">
<h3>${esc(it.title)}</h3>
<p><span class="tag ${it.severity === 'high' ? 'high' : ''}">${esc(it.severity ?? '?')}</span><span class="tag">${esc(it.domain ?? '?')}</span><span class="tag ok">${esc(it.state)}</span> <code>${esc(it.path ?? '?')}:${esc(it.line ?? '?')}</code>${it.symbol ? ` in <code>${esc(it.symbol)}</code>` : ''}</p>
<p><b>What goes wrong:</b> ${esc(it.scenario ?? '-')}</p>
<p><b>When:</b> ${when}. <span class="muted">${timeline}</span></p>
${it.snippet ? `<pre>${esc(it.snippet)}</pre>` : ''}
<details${open}><summary>The technique and why it applies</summary>
<p><b>How it was proved:</b> ${esc(it.confirm ?? '-')}</p><p><b>The fix direction:</b> ${esc(it.fixHint ?? '-')}</p>
${qs ? `<p><b>Pre-flight questions that catch this before the first edit:</b></p>${qs}` : ''}
<p><b>Sources:</b></p>${sources}${mode}</details>
<details${open}><summary>Before and after</summary>${ev(it.before, 'Before (failing)') || '<p class="muted">No before evidence recorded.</p>'}${ev(it.after, 'After the fix') || '<p class="muted">Not fixed in this run.</p>'}</details>
${it.note ? `<details${open}><summary>Researched for this project</summary><pre>${esc(it.note)}</pre></details>` : ''}
${verdicts}</div>`
}

function render({ run, items }, prefs) {
  const shown = items.filter(i => !prefs.mute.has(i.rule))
  const found = shown.filter(i => REPORTABLE.has(i.state))
  const ruledOut = shown.filter(i => !REPORTABLE.has(i.state))
  const muted = items.filter(i => prefs.mute.has(i.rule))
  const body = `
<h1>What /unslop found, and why it matters</h1>
<p class="muted">Run <code>${esc(run)}</code> · ${found.length} confirmed · ${ruledOut.length} ruled out · explanations: ${esc(prefs.level)}${prefs.notes.length ? ` · your notes: ${prefs.notes.map(esc).join('; ')}` : ''}</p>
${found.length ? found.map(i => renderItem(i, prefs)).join('') : '<p>No confirmed findings in this run.</p>'}
${ruledOut.length ? `<h2>Ruled out</h2>${ruledOut.map(i => `<div class="card"><h3>${esc(i.title)}</h3><p class="muted"><code>${esc(i.path)}:${esc(i.line)}</code> ${esc(i.state.toLowerCase())}: ${esc(i.reason ?? '')}</p></div>`).join('')}` : ''}
${muted.length ? `<p class="muted">Muted by your preference: ${muted.map(i => `<code>${esc(i.rule)}</code>`).join(', ')}.</p>` : ''}`
  return page({ title: 'Unslop explained', description: `What run ${run} found and fixed, with sources and evidence`, body })
}

function latestRun(repo) {
  const dir = path.join(repo, '.jstack', 'unslop', 'runs')
  try { const d = fs.readdirSync(dir).filter(f => fs.statSync(path.join(dir, f)).isDirectory()).sort().at(-1); return d ? path.join(dir, d) : null } catch { return null }
}

function build({ repo, runDir, out, skillsDir }) {
  const data = collectItems(runDir, { repo, skillsDir })
  const prefs = loadPrefs(repo)
  const file = writeSite(path.join(out ?? path.join(repo, '.jstack', 'local', 'site', 'explain'), 'index.html'), render(data, prefs))
  return { file, data, prefs }
}

// A verdict on one finding: feeds the rule thresholds (rules.mjs fieldPrecision) and the next explanation.
function feedback(repo, runDir, finding, { verdict, why = null, by = 'human', now = new Date() }) {
  if (!['accepted', 'rejected'].includes(verdict)) throw new Refusal('--verdict accepted|rejected')
  if (verdict === 'rejected' && (!why || why === true)) throw new Refusal('a rejection needs --why "<reason>"')
  const hist = ledgerRows(runDir).filter(r => r.finding === finding)
  if (!hist.length) throw new Refusal(`no finding ${finding} in ${runDir}`)
  const c = readJsonl(path.join(runDir, 'candidates.jsonl')).find(x => x.id === hist[0].candidate) ?? {}
  const clean = why ? redact(String(why)).text.slice(0, 300) : null
  const row = { rule: c.rule ?? null, fingerprint: c.fingerprint ?? null, run: path.basename(runDir), finding, verdict: verdict === 'rejected' ? `rejected:${clean}` : 'accepted', why: clean, by, at: now.toISOString() }
  const f = path.join(repo, '.jstack', 'local', 'feedback.jsonl')
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.appendFileSync(f, JSON.stringify(row) + '\n')
  return row
}

function prefer(repo, { level = null, mute = [], unmute = [], note = '' }) {
  if (!level && !mute.length && !unmute.length && !note) throw new Refusal('prefer needs --level, --mute, --unmute or --note')
  const now = new Date().toISOString()
  const entry = { id: newId(), kind: 'preference', status: 'active', title: `explain: ${[level && `level ${level}`, mute.length && `mute ${mute.join(',')}`, unmute.length && `unmute ${unmute.join(',')}`].filter(Boolean).join('; ') || 'note'}`, domains: [], anchors: [], prefs: { level, mute, unmute }, body: note ?? '', source: { by: 'human' }, created: now, updated: now }
  writeEntry(repo, entry)
  return entry
}

function main(argv) {
  const [cmd, a, b] = argv
  const get = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }
  const list = v => (v ? String(v).split(',').map(s => s.trim()).filter(Boolean) : [])
  const repo = path.resolve(get('--repo') ?? '.')
  try {
    if (cmd === 'build') {
      const runDir = get('--run') ?? latestRun(repo)
      if (!runDir) { console.error('no /unslop run found under .jstack/unslop/runs (or pass --run <dir>)'); return 2 }
      const r = build({ repo, runDir, out: get('--out') })
      console.log(`${r.file}: ${r.data.items.length} item(s), level ${r.prefs.level}`)
      return 0
    }
    if (cmd === 'feedback') { const r = feedback(repo, a, b, { verdict: get('--verdict'), why: get('--why'), by: get('--by') ?? 'human' }); console.log(`${r.finding}: ${r.verdict}`); return 0 }
    if (cmd === 'prefer') { const e = prefer(repo, { level: get('--level') ?? null, mute: list(get('--mute')), unmute: list(get('--unmute')), note: get('--note') ?? '' }); console.log(e.id); return 0 }
  } catch (e) {
    console.error(String(e.message ?? e))
    return 2
  }
  console.log('usage: explain.mjs build|feedback|prefer (see the header of this file)')
  return 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)))

export { build, collectItems, render, feedback, prefer, loadPrefs, sourcesFor, introducedBy, latestRun }
