// node --test tools/unslop/explain-metrify.test.mjs
// One real run (ledger + evidence) in a throwaway repo, then: the run record, the trend math, the explain site, the
// feedback and preference loop.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { initRun, append, addCandidates } from './ledger.mjs'
import { runEvidence, rerunEvidence } from './evidence.mjs'
import { buildRecord, record, loadRecords, trends } from './metrics.mjs'
import { render as renderMetrify } from './metrify.mjs'
import { build, collectItems, feedback, prefer, loadPrefs } from './explain.mjs'
import { main as reportMain } from './report.mjs'

const CANARY = 'sk-ant-api03-' + 'Qw7'.repeat(12)

function setup({ fix = true, runId = 'run-1', fp = 'conc.empty-catch|src/jobs/sync.ts#run|ab12' } = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'unslop-explain-'))
  const git = (...a) => { const r = spawnSync('git', a, { cwd: repo, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout }
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false')
  fs.mkdirSync(path.join(repo, 'src', 'jobs'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'src', 'jobs', 'sync.ts'), 'async function run(x) {\n  try { await x() } catch {}\n}\nexport { run }\n')
  git('add', '-A'); git('commit', '-q', '-m', 'feat(jobs): batch sync')
  return { repo, git, run: (id = runId, f = fp, doFix = fix) => makeRun(repo, id, f, doFix), done: () => fs.rmSync(repo, { recursive: true, force: true }) }
}

function makeRun(repo, id, fp, fix) {
  const dir = initRun(repo, id)
  const script = (name, body) => { const f = path.join(dir, name); fs.writeFileSync(f, body); return `node "${f}"` }
  const failing = script('fail.mjs', `console.log('token ${CANARY}'); console.error('AssertionError: expected FAILED, received DONE'); process.exit(1)\n`)
  const passing = script('pass.mjs', `console.log('ok')\n`)
  addCandidates(dir, [
    { id: 'c-aa11', source: 'static', rule: 'conc.empty-catch', domain: 'concurrency', title: 'Swallowed error', path: 'src/jobs/sync.ts', line: 2, severity: 'high', fingerprint: fp, scenario: 'provider throws -> batch marked done', snippet: 'try { await x() } catch {}' },
    { id: 'c-bb22', source: 'static', rule: 'perf.transition-all', domain: 'performance', title: 'transition: all', path: 'a.css', line: 1, severity: 'low', fingerprint: 'perf.transition-all|a.css@x|0000' },
  ])
  for (const f of ['f-aa11', 'f-bb22']) { append(dir, { finding: f, state: 'TRIAGED', by: 'o' }); append(dir, { finding: f, state: 'CONFIRMING', by: 'o' }) }
  append(dir, { finding: 'f-bb22', state: 'DISMISSED', by: 'skeptic', reason: 'only on hover of a static icon' })
  runEvidence(dir, { id: 'e1', kind: 'failing-test', by: 'prosecutor', cmd: failing, cwd: repo })
  rerunEvidence(dir, { id: 'e1', by: 'skeptic', cwd: repo })
  append(dir, { finding: 'f-aa11', state: 'CONFIRMED', by: 'skeptic', evidence: ['evidence/e1.evidence.json'] })
  if (fix) {
    append(dir, { finding: 'f-aa11', state: 'TEST_RED', by: 'fixer', evidence: ['evidence/e1.evidence.json'] })
    append(dir, { finding: 'f-aa11', state: 'FIX_PROPOSED', by: 'fixer' })
    append(dir, { finding: 'f-aa11', state: 'FIXED', by: 'fixer' })
    runEvidence(dir, { id: 'e2', kind: 'failing-test', by: 'fixer', cmd: passing, cwd: repo })
    append(dir, { finding: 'f-aa11', state: 'VERIFIED', by: 'skeptic', evidence: ['evidence/e2.evidence.json'] })
  }
  return dir
}

test('metrics: a run leaves a before/after record with domain counts, fingerprints, time to fix and pre-flight links', () => {
  const s = setup()
  try {
    fs.mkdirSync(path.join(s.repo, '.agent'))
    fs.writeFileSync(path.join(s.repo, '.agent', 'preflight.md'), 'Answered: conc.q.commit-point -> after the insert\n')
    const dir = s.run()
    const r = buildRecord(dir, { repo: s.repo, scope: 'branch' })
    assert.deepEqual(r.before.byDomain, { concurrency: 1, performance: 1 })
    assert.equal(r.confirmed.total, 1)
    assert.deepEqual({ fixed: r.after.fixed, verified: r.after.verified, dismissed: r.after.dismissed }, { fixed: 1, verified: 1, dismissed: 1 })
    assert.equal(r.timeToFix.length, 1)
    assert.ok(r.caughtBy.length >= 1, 'silent-loss maps to at least one concurrency question')
    assert.ok(r.caughtBy.some(q => q.question === 'conc.q.commit-point' && q.asked === true))
    assert.ok(!JSON.stringify(r).includes(CANARY))
  } finally { s.done() }
})

test('negative: report.mjs records metrics automatically, and --no-metrics or a broken run dir records nothing', () => {
  const s = setup()
  try {
    const dir = s.run()
    const log = console.log; console.log = () => {}
    try { reportMain([dir, '--no-metrics']) } finally { console.log = log }
    assert.equal(loadRecords(s.repo).length, 0)
    console.log = () => {}
    try { reportMain([dir, '--scope', 'branch']) } finally { console.log = log }
    assert.equal(loadRecords(s.repo).length, 1)
    assert.equal(loadRecords(s.repo)[0].scope, 'branch')
    fs.mkdirSync(path.join(s.repo, '.jstack', 'metrics', 'runs'), { recursive: true })
    fs.writeFileSync(path.join(s.repo, '.jstack', 'metrics', 'runs', 'junk.json'), '{not json')
    assert.equal(loadRecords(s.repo).length, 1, 'an unreadable record is skipped, not fatal')
  } finally { s.done() }
})

test('trends: a fingerprint fixed in one run and seen again later counts as recurring', () => {
  const s = setup()
  try {
    record(s.run('run-1', undefined, true), { repo: s.repo, now: new Date('2026-10-01T00:00:00Z') })
    record(s.run('run-2', undefined, false), { repo: s.repo, now: new Date('2026-10-08T00:00:00Z') })
    const t = trends(loadRecords(s.repo))
    assert.equal(t.runs, 2)
    assert.equal(t.recurring[0].rule, 'conc.empty-catch')
    assert.equal(t.recurring[0].recurred, 1)
    assert.equal(t.domains.concurrency.length, 2)
    const html = renderMetrify(t, { repoName: 'x' })
    assert.match(html, /Top recurring slop/)
    assert.match(html, /1x after a fix/)
  } finally { s.done() }
})

test('negative: trends on no runs, or on a fingerprint seen once and never fixed, report no recurrence', () => {
  assert.equal(trends([]).recurrenceRate, null)
  assert.match(renderMetrify(trends([])), /No \/unslop run has been recorded/)
  const s = setup()
  try {
    record(s.run('run-1', undefined, false), { repo: s.repo })
    const t = trends(loadRecords(s.repo))
    assert.equal(t.recurring.length, 0)
    assert.equal(t.recurrenceRate, 0)
  } finally { s.done() }
})

test('explain: each confirmed finding gets when, technique, sources, before/after; secrets never reach the page', () => {
  const s = setup()
  try {
    const dir = s.run()
    fs.mkdirSync(path.join(s.repo, '.jstack', 'local', 'explain', 'notes'), { recursive: true })
    fs.writeFileSync(path.join(s.repo, '.jstack', 'local', 'explain', 'notes', 'conc.empty-catch.md'), `Our queue retries 3 times. leaked ${CANARY}`)
    const { file, data } = build({ repo: s.repo, runDir: dir })
    const it = data.items.find(i => i.finding === 'f-aa11')
    assert.match(it.introduced.summary, /batch sync/)
    assert.ok(it.before.length && it.after.length)
    assert.ok(it.sources.length >= 1, 'a SOURCES.md line matched the rule')
    assert.ok(it.questions.length >= 1)
    const html = fs.readFileSync(file, 'utf8')
    assert.match(html, /Researched for this project/)
    assert.match(html, /Ruled out/)
    assert.ok(!html.includes(CANARY))
  } finally { s.done() }
})

test('negative: feedback refuses a rejection without a reason and an unknown finding; a verdict changes the page and the field precision', () => {
  const s = setup()
  try {
    const dir = s.run()
    assert.throws(() => feedback(s.repo, dir, 'f-aa11', { verdict: 'rejected' }), /needs --why/)
    assert.throws(() => feedback(s.repo, dir, 'f-zz99', { verdict: 'accepted' }), /no finding/)
    assert.throws(() => feedback(s.repo, dir, 'f-aa11', { verdict: 'maybe' }), /accepted\|rejected/)
    feedback(s.repo, dir, 'f-aa11', { verdict: 'rejected', why: 'cleanup path, loss is fine' })
    const it = collectItems(dir, { repo: s.repo }).items.find(i => i.finding === 'f-aa11')
    assert.equal(it.verdicts[0].why, 'cleanup path, loss is fine')
    assert.equal(it.field.rejected, 1)
  } finally { s.done() }
})

test('negative: preferences need content, bad rule ids are refused, and short + mute change later pages', () => {
  const s = setup()
  try {
    const dir = s.run()
    assert.throws(() => prefer(s.repo, {}), /needs/)
    assert.throws(() => prefer(s.repo, { mute: ['bad id; rm -rf'] }), /prefs\.mute/)
    prefer(s.repo, { level: 'short', note: 'I know idempotency; keep it brief' })
    prefer(s.repo, { mute: ['conc.empty-catch'] })
    const p = loadPrefs(s.repo)
    assert.equal(p.level, 'short')
    assert.ok(p.mute.has('conc.empty-catch'))
    const html = fs.readFileSync(build({ repo: s.repo, runDir: dir }).file, 'utf8')
    assert.match(html, /Muted by your preference/)
    assert.doesNotMatch(html, /<details open>/)
    prefer(s.repo, { unmute: ['conc.empty-catch'] })
    assert.equal(loadPrefs(s.repo).mute.size, 0)
  } finally { s.done() }
})
